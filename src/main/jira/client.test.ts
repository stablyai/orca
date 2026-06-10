import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_FETCH = globalThis.fetch

type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

let tempHome = ''
let fetchMock: ReturnType<typeof vi.fn>

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function tokenPathForSite(siteId: string): string {
  return join(tempHome, '.orca', 'jira-tokens', `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function writeJiraFiles(siteId: string, token: string | Buffer): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'jira-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: 'https://example.atlassian.net',
            email: 'ada@example.com',
            displayName: 'Ada',
            accountId: 'account-alpha'
          }
        ]
      },
      null,
      2
    ),
    { encoding: 'utf-8' }
  )
  writeFileSync(tokenPathForSite(siteId), token)
}

async function loadClientModule(options: SafeStorageMockOptions = {}) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => options.encryptionAvailable ?? false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: options.decryptString ?? ((value: Buffer) => value.toString('utf-8'))
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })

  return import('./client')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-jira-client-')
  fetchMock = vi.fn(async () => {
    throw new Error('fetch should not be called')
  })
  globalThis.fetch = fetchMock as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('Jira client credential storage', () => {
  it('preserves plaintext fallback and reaches Jira auth header construction', async () => {
    const siteId = 'site-alpha'
    writeJiraFiles(siteId, 'token-alpha')
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accountId: 'account-alpha',
          displayName: 'Ada',
          emailAddress: 'ada@example.com'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('not encrypted')
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Ada' }
    })

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada@example.com:token-alpha').toString('base64')}`
    )
  })

  it('does not pass encrypted safeStorage bytes to Jira when encryption is unavailable', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    const jira = await loadClientModule({ encryptionAvailable: false })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.',
      sites: [{ id: siteId }]
    })
  })

  it('does not clear the Jira token when safeStorage decryption fails', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.',
      sites: [{ id: siteId }]
    })
  })

  it('does not clear plaintext fallback credentials on Jira auth failure after decrypt failure', async () => {
    const siteId = 'site-alpha'
    const tokenPath = tokenPathForSite(siteId)
    writeJiraFiles(siteId, 'token-revoked')
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errorMessages: ['Jira authentication failed'] }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Jira authentication failed'
    })

    expect(existsSync(tokenPath)).toBe(true)
    expect(jira.getStatus()).toMatchObject({
      connected: true,
      sites: [{ id: siteId }]
    })
  })

  it('clears the recorded credential error after Keychain access is approved', async () => {
    const siteId = 'site-alpha'
    let keychainApproved = false
    writeJiraFiles(siteId, Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accountId: 'account-alpha',
          displayName: 'Ada',
          emailAddress: 'ada@example.com'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        if (!keychainApproved) {
          throw new Error('userCanceledErr')
        }
        return 'token-alpha'
      }
    })

    await expect(jira.testConnection(siteId)).resolves.toMatchObject({ ok: false })
    expect(jira.getStatus().credentialError).toContain('Could not decrypt')

    keychainApproved = true
    await expect(jira.testConnection(siteId)).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Ada' }
    })
    expect(jira.getStatus().credentialError).toBeUndefined()
  })

  it('treats empty Jira token files as missing credentials', async () => {
    const siteId = 'site-alpha'
    writeJiraFiles(siteId, Buffer.alloc(0))
    const jira = await loadClientModule({ encryptionAvailable: false })

    await expect(jira.testConnection(siteId)).resolves.toEqual({
      ok: false,
      error: 'Not connected to Jira.'
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(jira.getStatus()).toMatchObject({ connected: false })
  })
})
