import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import {
  createCommand,
  createLifecycleClaim
} from './browser-client-page-command-executor-test-harness'
import { createBrowserRoutePartitionBindingStoreFake } from './browser-route-partition-binding-store-fake'
import {
  BrowserRouteSessionRegistry,
  type BrowserRouteElectronSession
} from './browser-route-session-registry'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

const SSH_HOST_STORAGE = 'storage-ssh-target-a'
const OTHER_HOST_STORAGE = 'storage-ssh-target-b'
const GENERATION_1 = 'execution-host-ssh-a-gen-1'
const GENERATION_2 = 'execution-host-ssh-a-gen-2'
const OTHER_HOST = 'execution-host-ssh-b-gen-1'

const proxyPortByKey: Record<string, number> = {
  [GENERATION_1]: 43123,
  [GENERATION_2]: 43124,
  [OTHER_HOST]: 43125
}

const storageIdentityByKey: Record<string, string> = {
  [GENERATION_1]: SSH_HOST_STORAGE,
  [GENERATION_2]: SSH_HOST_STORAGE,
  [OTHER_HOST]: OTHER_HOST_STORAGE
}

function createHarness() {
  const releasedRoutes: string[] = []
  const proxyRulesByPartition = new Map<string, string>()
  const sessionsByPartition = new Map<string, BrowserRouteElectronSession>()
  let nextWebContentsId = 40

  const getSession = (partition: string): BrowserRouteElectronSession => {
    const existing = sessionsByPartition.get(partition)
    if (existing) {
      return existing
    }
    const created: BrowserRouteElectronSession = {
      setProxy: vi.fn(async ({ proxyRules }) => {
        proxyRulesByPartition.set(partition, proxyRules)
      }),
      closeAllConnections: vi.fn(async () => {}),
      resolveProxy: vi.fn(async () =>
        (proxyRulesByPartition.get(partition) ?? '').replace('socks5://', 'SOCKS5 ')
      )
    }
    sessionsByPartition.set(partition, created)
    return created
  }

  const routeSessions = new BrowserRouteSessionRegistry({
    // Storage identity, not the route key, names the partition: it survives an SSH reconnect.
    derivePartition: (identity) => ({
      partition: `persist:${identity.executionHostIdentity}`,
      bindingFingerprint: `${identity.executionHostIdentity}`.padEnd(64, 'f')
    }),
    validateProfile: vi.fn(),
    getSession: vi.fn(getSession),
    setupPolicies: vi.fn(),
    clearPolicies: vi.fn(),
    retirePageAuthority: vi.fn(() => true),
    bindingStore: createBrowserRoutePartitionBindingStoreFake()
  })

  const dependencies = {
    orcaProfileId: 'orca-profile-a',
    authorityConnectionIdentity: 'authority-record-a',
    legacyAuthorityConnectionIdentity: 'legacy-authority-record-a',
    storageScope: 'a'.repeat(64),
    retainNetworkRoute: vi.fn(async (executionHostKey: string) => ({
      key: executionHostKey,
      executionHostIdentity: storageIdentityByKey[executionHostKey],
      legacyExecutionHostIdentity: `legacy-${storageIdentityByKey[executionHostKey]}`,
      proxyEndpoint: { host: '127.0.0.1' as const, port: proxyPortByKey[executionHostKey] },
      release: vi.fn(() => {
        releasedRoutes.push(executionHostKey)
      })
    })),
    selectRenderer: vi.fn(() => ({
      rendererWebContentsId: 11,
      isCurrent: () => true,
      mountPage: vi.fn(async () => {
        nextWebContentsId += 1
        return { webContentsId: nextWebContentsId }
      }),
      retirePage: vi.fn(async () => {})
    })),
    routeSessions,
    executeAutomation: vi.fn(async () => ({})),
    retireAutomation: vi.fn(async () => {}),
    guestBinding: { bind: vi.fn(), release: vi.fn() },
    routeWebContents: {
      claimGuestLifecycle: vi.fn((registration: BrowserRoutePageGuestIdentity) =>
        createLifecycleClaim(registration)
      ),
      registerGuest: vi.fn(() => true),
      grantNavigation: vi.fn(() => true),
      revokeNavigation: vi.fn(() => true),
      navigateGuest: vi.fn(async () => true),
      beginGuestRetirement: vi.fn(() => Promise.resolve())
    }
  }

  return {
    executor: new BrowserClientPageCommandExecutor(dependencies),
    proxyRulesFor: (storageIdentity: string) =>
      proxyRulesByPartition.get(`persist:${storageIdentity}`),
    releasedRoutes
  }
}

function createPageCommand(
  browserPageId: string,
  executionHostKey: string
): BrowserClientHostCommandEvent {
  return createCommand('createPage', {
    browserPageId,
    commandId: `createPage-${browserPageId}`,
    command: { type: 'createPage', browserProfileId: 'profile-a', executionHostKey }
  } as Partial<BrowserClientHostCommandEvent>)
}

function createPage(
  executor: BrowserClientPageCommandExecutor,
  browserPageId: string,
  executionHostKey: string
) {
  return executor.handle(
    createPageCommand(browserPageId, executionHostKey),
    new AbortController().signal
  )
}

describe('client-hosted pages across an execution host generation change', () => {
  it('retires the superseded pages so the reconnected route can bind the partition', async () => {
    const harness = createHarness()

    expect(await createPage(harness.executor, 'page-a', GENERATION_1)).toEqual({
      status: 'completed'
    })
    expect(await createPage(harness.executor, 'page-b', GENERATION_2)).toEqual({
      status: 'completed'
    })

    expect(harness.executor.hasPage('page-a', 7)).toBe(false)
    expect(harness.executor.hasPage('page-b', 7)).toBe(true)
    expect(harness.releasedRoutes).toEqual([GENERATION_1])
    expect(harness.proxyRulesFor(SSH_HOST_STORAGE)).toBe('socks5://127.0.0.1:43124')
  })

  it('keeps the sibling pages that share the current route key', async () => {
    const harness = createHarness()

    await createPage(harness.executor, 'page-a', GENERATION_1)
    expect(await createPage(harness.executor, 'page-b', GENERATION_1)).toEqual({
      status: 'completed'
    })

    expect(harness.executor.hasPage('page-a', 7)).toBe(true)
    expect(harness.executor.hasPage('page-b', 7)).toBe(true)
    expect(harness.releasedRoutes).toEqual([])
  })

  it('keeps the pages held on a different execution host', async () => {
    const harness = createHarness()

    await createPage(harness.executor, 'page-a', OTHER_HOST)
    expect(await createPage(harness.executor, 'page-b', GENERATION_2)).toEqual({
      status: 'completed'
    })

    expect(harness.executor.hasPage('page-a', 7)).toBe(true)
    expect(harness.executor.hasPage('page-b', 7)).toBe(true)
    expect(harness.releasedRoutes).toEqual([])
    expect(harness.proxyRulesFor(OTHER_HOST_STORAGE)).toBe('socks5://127.0.0.1:43125')
    expect(harness.proxyRulesFor(SSH_HOST_STORAGE)).toBe('socks5://127.0.0.1:43124')
  })
})
