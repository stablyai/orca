import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_FETCH = globalThis.fetch
const { closeAllConnectionsMock, netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(
  () => ({
    closeAllConnectionsMock: vi.fn(),
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn()
  })
)

type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

let tempHome = ''
let fetchMock: ReturnType<typeof vi.fn>

function tokenPathForWorkspace(workspaceId: string): string {
  return join(
    tempHome,
    '.orca',
    'shortcut-tokens',
    `${Buffer.from(workspaceId).toString('base64url')}.enc`
  )
}

function writeShortcutFiles(workspaceId: string, token: string | Buffer): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'shortcut-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'shortcut-workspaces.json'),
    JSON.stringify(
      {
        version: 1,
        activeWorkspaceId: workspaceId,
        selectedWorkspaceId: workspaceId,
        workspaces: [
          {
            id: workspaceId,
            urlSlug: 'acme',
            name: 'Acme',
            memberId: 'member-alpha',
            memberName: 'Ada',
            mentionName: 'ada'
          }
        ]
      },
      null,
      2
    ),
    { encoding: 'utf-8' }
  )
  writeFileSync(tokenPathForWorkspace(workspaceId), token)
}

async function loadClientModule(options: SafeStorageMockOptions = {}) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => netFetchMock(url, init),
    proxySession: () => ({ resolveProxy: resolveProxyMock, setProxy: setProxyMock }) as never
  })
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => options.encryptionAvailable ?? false,
    encryptString: (value) => Buffer.from(value),
    decryptString: options.decryptString ?? ((value) => value.toString('utf-8')),
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })

  // One import call per reset so the split modules share a single graph (and
  // thus one copy of the request queue / credential caches) per test.
  const [client, queue, api] = await Promise.all([
    import('./client'),
    import('./request-queue'),
    import('./authenticated-request')
  ])
  return { ...client, ...queue, ...api }
}

function memberInfoResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'member-alpha',
      mention_name: 'ada',
      name: 'Ada',
      workspace2: { url_slug: 'acme', name: 'Acme', estimate_scale: [] }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-shortcut-client-'))
  fetchMock = vi.fn(async () => {
    throw new Error('fetch should not be called')
  })
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
  globalThis.fetch = fetchMock as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('Shortcut client connect', () => {
  it('verifies the token against /member, stores it, and records the workspace', async () => {
    netFetchMock.mockResolvedValueOnce(memberInfoResponse())
    const shortcut = await loadClientModule()

    await expect(shortcut.connect({ apiToken: 'token-alpha' })).resolves.toMatchObject({
      ok: true,
      viewer: { id: 'member-alpha', name: 'Ada', mentionName: 'ada' }
    })

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.app.shortcut.com/api/v3/member',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Shortcut-Token')).toBe('token-alpha')
    expect(headers.get('Authorization')).toBeNull()

    const status = shortcut.getStatus()
    expect(status.connected).toBe(true)
    expect(status.workspaces).toHaveLength(1)
    expect(status.workspaces?.[0]).toMatchObject({
      urlSlug: 'acme',
      name: 'Acme',
      memberId: 'member-alpha',
      mentionName: 'ada'
    })
    const workspaceId = status.workspaces?.[0]?.id ?? ''
    expect(existsSync(tokenPathForWorkspace(workspaceId))).toBe(true)
    expect(readFileSync(tokenPathForWorkspace(workspaceId), 'utf-8')).toBe('token-alpha')
  })

  it('keeps two accounts of the same workspace as distinct connections', async () => {
    netFetchMock.mockResolvedValueOnce(memberInfoResponse()).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'member-beta',
          mention_name: 'brie',
          name: 'Brie',
          workspace2: { url_slug: 'acme', name: 'Acme', estimate_scale: [] }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const shortcut = await loadClientModule()

    await shortcut.connect({ apiToken: 'token-alpha' })
    await shortcut.connect({ apiToken: 'token-beta' })

    const status = shortcut.getStatus()
    expect(status.workspaces).toHaveLength(2)
    const ids = new Set(status.workspaces?.map((workspace) => workspace.id))
    expect(ids.size).toBe(2)
  })

  it('rejects an invalid token with the API error message', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Sorry, we could not authenticate you.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const shortcut = await loadClientModule()

    await expect(shortcut.connect({ apiToken: 'bad-token' })).resolves.toEqual({
      ok: false,
      error: 'Sorry, we could not authenticate you.'
    })
    expect(shortcut.getStatus().connected).toBe(false)
  })
})

describe('Shortcut client stored credentials', () => {
  it('preserves plaintext fallback and sends the Shortcut-Token header', async () => {
    const workspaceId = 'workspace-alpha'
    writeShortcutFiles(workspaceId, 'token-alpha')
    netFetchMock.mockResolvedValueOnce(memberInfoResponse())
    const shortcut = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('not encrypted')
      }
    })

    await expect(shortcut.testConnection(workspaceId)).resolves.toMatchObject({
      ok: true,
      viewer: { name: 'Ada' }
    })

    expect(fetchMock).not.toHaveBeenCalled()
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Shortcut-Token')).toBe('token-alpha')
  })

  it('records a credential error when a stored token cannot be decrypted', async () => {
    const workspaceId = 'workspace-alpha'
    // Sealed ciphertext: control bytes are never printable legacy plaintext.
    writeShortcutFiles(workspaceId, Buffer.from([0x01, 0x02, 0x03]))
    const shortcut = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('cannot decrypt')
      }
    })

    expect(() => shortcut.getClients(workspaceId)).toThrow(/Could not decrypt saved Shortcut/)
    expect(shortcut.getStatus().credentialError).toMatch(/Shortcut/)
  })

  it('disconnect removes the workspace and its token', async () => {
    const workspaceId = 'workspace-alpha'
    writeShortcutFiles(workspaceId, 'token-alpha')
    const shortcut = await loadClientModule()

    expect(shortcut.getStatus().connected).toBe(true)
    shortcut.disconnect(workspaceId)
    expect(shortcut.getStatus().connected).toBe(false)
    expect(existsSync(tokenPathForWorkspace(workspaceId))).toBe(false)
  })

  it('selectWorkspace persists the selection including all', async () => {
    const workspaceId = 'workspace-alpha'
    writeShortcutFiles(workspaceId, 'token-alpha')
    const shortcut = await loadClientModule()

    const status = shortcut.selectWorkspace('all')
    expect(status.selectedWorkspaceId).toBe('all')
    expect(status.activeWorkspaceId).toBe(workspaceId)
    const persisted = JSON.parse(
      readFileSync(join(tempHome, '.orca', 'shortcut-workspaces.json'), 'utf-8')
    ) as { selectedWorkspaceId: string }
    expect(persisted.selectedWorkspaceId).toBe('all')
  })

  it('treats only 401 as an auth error', async () => {
    const shortcut = await loadClientModule()
    expect(shortcut.isAuthError(new shortcut.ShortcutApiError('nope', 401))).toBe(true)
    expect(shortcut.isAuthError(new shortcut.ShortcutApiError('forbidden', 403))).toBe(false)
    expect(shortcut.isAuthError(new Error('401'))).toBe(false)
  })
})
