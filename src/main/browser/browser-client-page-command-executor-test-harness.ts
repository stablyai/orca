import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { vi } from 'vitest'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'

export const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`

export function createCommand(
  type: 'createPage' | 'navigate',
  overrides: Partial<BrowserClientHostCommandEvent> = {}
): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 3,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    commandSequence: type === 'createPage' ? 1 : 2,
    commandId: `${type}-a`,
    command:
      type === 'createPage'
        ? {
            type: 'createPage',
            browserProfileId: 'profile-a',
            executionHostKey: 'execution-host-a'
          }
        : { type: 'navigate', url: 'example.internal/path' },
    ...overrides
  } as BrowserClientHostCommandEvent
}

export function createLifecycleClaim(
  registration: BrowserRoutePageGuestIdentity,
  whenDestroyed: Promise<void> = Promise.resolve(),
  isCurrent = () => true
): BrowserRouteGuestLifecycleClaim {
  return {
    registration: { ...registration },
    guestAuthority: Symbol('guest-authority'),
    whenDestroyed,
    isCurrent
  }
}

export function createHarness(options: { maxPages?: number } = {}) {
  const order: string[] = []
  let rendererCurrent = true
  const route = {
    key: 'execution-host-a',
    executionHostIdentity: 'execution-host-record-a',
    legacyExecutionHostIdentity: 'legacy-execution-host-record-a',
    proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
    release: vi.fn(async () => {
      order.push('release-route')
    })
  }
  const routeSession = {
    partition,
    release: vi.fn(() => {
      order.push('release-session')
    })
  }
  const renderer = {
    rendererWebContentsId: 11,
    isCurrent: vi.fn(() => rendererCurrent),
    mountPage: vi.fn(async () => {
      order.push('mount-page')
      return { webContentsId: 41 }
    }),
    retirePage: vi.fn(async () => {
      order.push('retire-renderer-page')
    })
  }
  const dependencies = {
    orcaProfileId: 'orca-profile-a',
    authorityConnectionIdentity: 'authority-record-a',
    legacyAuthorityConnectionIdentity: 'legacy-authority-record-a',
    storageScope: 'a'.repeat(64),
    maxPages: options.maxPages,
    retainNetworkRoute: vi.fn(async () => {
      order.push('retain-route')
      return route
    }),
    selectRenderer: vi.fn(() => renderer),
    routeSessions: {
      preparePage: vi.fn(async () => {
        order.push('prepare-page')
        return routeSession
      })
    },
    executeAutomation: vi.fn(async () => ({ clicked: true })),
    retireAutomation: vi.fn(async () => {}),
    guestBinding: {
      bind: vi.fn(() => {
        order.push('bind-guest')
      }),
      release: vi.fn(() => {
        order.push('release-guest')
      })
    },
    routeWebContents: {
      claimGuestLifecycle: vi.fn((registration: BrowserRoutePageGuestIdentity) => {
        order.push('claim-guest')
        return createLifecycleClaim(registration)
      }),
      registerGuest: vi.fn(() => {
        order.push('register-guest')
        return true
      }),
      grantNavigation: vi.fn(() => {
        order.push('grant-navigation')
        return true
      }),
      revokeNavigation: vi.fn(() => {
        order.push('revoke-navigation')
        return true
      }),
      navigateGuest: vi.fn(async () => {
        order.push('navigate-guest')
        return true
      }),
      beginGuestRetirement: vi.fn(() => {
        order.push('retire-guest')
        return Promise.resolve()
      })
    }
  }
  return {
    dependencies,
    executor: new BrowserClientPageCommandExecutor(dependencies),
    order,
    renderer,
    route,
    routeSession,
    setRendererCurrent: (value: boolean) => {
      rendererCurrent = value
    }
  }
}
