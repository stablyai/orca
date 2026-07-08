import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { closeAllConnectionsMock, netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(
  () => ({
    closeAllConnectionsMock: vi.fn(),
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn()
  })
)

let tempHome = ''

function tokenPathForSite(siteId: string): string {
  return join(tempHome, '.orca', 'jira-tokens', `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function writeJiraFiles(siteId: string, token: string): void {
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

async function loadClientModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString('utf-8')
    },
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })

  return import('./client')
}

describe('Jira client credential failure handling', () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'orca-jira-client-failure-'))
    netFetchMock.mockReset()
    resolveProxyMock.mockReset()
    setProxyMock.mockReset()
    closeAllConnectionsMock.mockReset()
    resolveProxyMock.mockResolvedValue('DIRECT')
  })

  it('removes a new saved Jira secret if site metadata persistence fails', async () => {
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-sites.json'), { recursive: true })
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: 'ada',
          displayName: 'Ada Server',
          emailAddress: 'ada@example.internal'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const jira = await loadClientModule()

    await expect(
      jira.connect({
        deploymentType: 'server',
        authMode: 'basic',
        siteUrl: 'https://jira.example.internal/',
        username: 'ada',
        passwordOrToken: 'server-secret'
      })
    ).resolves.toMatchObject({ ok: false })

    expect(readdirSync(join(orcaDir, 'jira-tokens'))).toEqual([])
    expect(jira.getStatus()).toMatchObject({ connected: false, sites: [] })
  })

  it('surfaces Jira secret deletion failures other than missing token files', async () => {
    const siteId = 'site-alpha'
    writeJiraFiles(siteId, 'token-alpha')
    rmSync(tokenPathForSite(siteId))
    mkdirSync(tokenPathForSite(siteId))
    const jira = await loadClientModule()

    expect(() => jira.disconnect(siteId)).toThrow()
  })
})
