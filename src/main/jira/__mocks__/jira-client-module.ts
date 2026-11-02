import type * as Os from 'node:os'
import { vi, type Mock } from 'vitest'

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

export async function loadJiraClientModule(
  mocks: JiraClientMocks,
  tempHome: string,
  options: SafeStorageMockOptions = {}
) {
  const { closeAllConnectionsMock, netFetchMock, resolveProxyMock, setProxyMock } = mocks
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
  // Why here and not in beforeEach: vi.resetModules() above gives the http-client module
  // a fresh singleton, so the port must be installed on that instance. The electron net
  // mock alone is inert now that Jira fetches through the port.
  const { setMainHttpClient } = await import('../../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => netFetchMock(url, init),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These are the only session methods the proxy fixture exercises.
    proxySession: () => ({ resolveProxy: resolveProxyMock, setProxy: setProxyMock }) as never
  })
  const { setSecretStore } = await import('../../../shared/secret-store')
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
    import('../client'),
    import('../request-queue'),
    import('../authenticated-request')
  ])
  return { ...client, ...queue, ...api }
}
