import AsyncStorage from '@react-native-async-storage/async-storage'
import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import {
  useMobileWebColdResumeRoute,
  type MobileWebColdResumeRouteBinding
} from './use-mobile-web-cold-resume-route'
import {
  MOBILE_WEB_NAVIGATION_INTENTS,
  type MobileWebNavigationIntent
} from './mobile-web-navigation-intent-buffer'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

let renderer: ReactTestRenderer | null = null

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('useMobileWebColdResumeRoute', () => {
  it('does not replace an explicit host with the persisted cold-resume host', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        version: 1,
        hostIdentity: 'paired-host',
        hostWorkspaceIdentity: 'host-workspace'
      })
    )
    const selectHost = vi.fn()

    await act(async () => {
      renderer = create(
        createElement(Harness, {
          options: options({
            explicitHostId: 'e2e-host',
            selectedHostId: 'e2e-host',
            selectHost
          }),
          capture: () => {}
        })
      )
      await Promise.resolve()
    })

    expect(selectHost).not.toHaveBeenCalled()
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled()
  })

  it('selects a paired host and ignores the bootstrap list route until fresh resolution', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({
        version: 1,
        hostIdentity: 'paired-host',
        hostWorkspaceIdentity: 'host-workspace'
      })
    )
    const selectHost = vi.fn()
    const intents: MobileWebNavigationIntent[] = []
    const unsubscribe = MOBILE_WEB_NAVIGATION_INTENTS.subscribe((intent) => intents.push(intent))
    let binding: MobileWebColdResumeRouteBinding | null = null

    await act(async () => {
      renderer = create(
        createElement(Harness, {
          options: options({ selectHost }),
          capture: (value) => {
            binding = value
          }
        })
      )
      await Promise.resolve()
    })
    expect(selectHost).toHaveBeenCalledWith('paired-host')

    await act(async () => {
      renderer?.update(
        createElement(Harness, {
          options: options({
            selectHost,
            selectedHostId: 'paired-host',
            shellSessionId: 'S'.repeat(43)
          }),
          capture: (value) => {
            binding = value
          }
        })
      )
    })
    const intent = intents.at(-1)
    expect(intent).toMatchObject({
      source: 'coldResume',
      hostId: 'paired-host',
      target: { kind: 'session', hostWorkspaceId: 'host-workspace' }
    })

    act(() => binding?.rememberHostRoute({ kind: 'workspaceList' }))
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled()

    await act(async () => {
      if (intent) {
        binding?.onNavigationResolved(intent, {
          kind: 'session',
          workspaceId: 'opaque-workspace',
          workspaceName: 'Workspace'
        })
      }
      binding?.rememberHostRoute({
        kind: 'session',
        hostWorkspaceId: 'host-workspace'
      })
      await Promise.resolve()
    })
    expect(AsyncStorage.setItem).toHaveBeenCalled()

    if (intent) {
      MOBILE_WEB_NAVIGATION_INTENTS.consume(intent.sequence)
    }
    unsubscribe()
  })
})

function Harness({
  options: hookOptions,
  capture
}: {
  options: Parameters<typeof useMobileWebColdResumeRoute>[0]
  capture: (binding: MobileWebColdResumeRouteBinding) => void
}) {
  const binding = useMobileWebColdResumeRoute(hookOptions)
  useEffect(() => {
    capture(binding)
  }, [binding, capture])
  return null
}

function options(
  overrides: Partial<Parameters<typeof useMobileWebColdResumeRoute>[0]> = {}
): Parameters<typeof useMobileWebColdResumeRoute>[0] {
  return {
    hosts: [{ id: 'paired-host' }] as HostProfile[],
    hostsLoading: false,
    hostsLoadFailed: false,
    explicitHostId: undefined,
    selectedHostId: undefined,
    shellSessionId: undefined,
    selectHost: vi.fn(),
    ...overrides
  }
}
