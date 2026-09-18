import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'

/** The hoisted electron net/session mocks every Jira client test file installs. */
export type JiraClientMocks = {
  closeAllConnectionsMock: Mock
  netFetchMock: Mock
  resolveProxyMock: Mock
  setProxyMock: Mock
}

export type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

export function createJiraTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'orca-jira-client-'))
}

export function jiraTokenPath(home: string, siteId: string): string {
  return join(home, '.orca', 'jira-tokens', `${Buffer.from(siteId).toString('base64url')}.enc`)
}

/** Shared per-test reset; returns the global fetch guard, which callers restore after each test. */
export function resetJiraClientMocks(mocks: JiraClientMocks): Mock {
  const fetchMock = vi.fn(async () => {
    throw new Error('fetch should not be called')
  })
  mocks.netFetchMock.mockReset()
  mocks.resolveProxyMock.mockReset()
  mocks.setProxyMock.mockReset()
  mocks.closeAllConnectionsMock.mockReset()
  mocks.resolveProxyMock.mockResolvedValue('DIRECT')
  globalThis.fetch = fetchMock as typeof fetch
  vi.restoreAllMocks()
  return fetchMock
}

export async function loadJiraClientModule(
  mocks: JiraClientMocks,
  home: string,
  options: SafeStorageMockOptions = {}
) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: mocks.netFetchMock },
    session: {
      defaultSession: {
        closeAllConnections: mocks.closeAllConnectionsMock,
        resolveProxy: mocks.resolveProxyMock,
        setProxy: mocks.setProxyMock
      }
    }
  }))
  // Why here and not in beforeEach: vi.resetModules() above gives the http-client module
  // a fresh singleton, so the port must be installed on that instance. The electron net
  // mock alone is inert now that Jira fetches through the port.
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => mocks.netFetchMock(url, init),
    proxySession: () =>
      ({ resolveProxy: mocks.resolveProxyMock, setProxy: mocks.setProxyMock }) as never
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
    return { ...actual, homedir: () => home }
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
