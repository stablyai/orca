import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { webHostScreenShellOperations } from '../worktree/web-host-screen-shell-operations'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { handleMobileWebBrokerMessage } from './mobile-web-broker-message-handoff'
import { MobileWebNativeRouteHandoff } from './mobile-web-native-route-handoff'
import { MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS } from './mobile-web-production-navigation-grants'
import { useMobileWebNavigationAuthority } from './use-mobile-web-navigation-authority'
import { leaveHostRoute } from '../host-route-exit'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import type { MobileWebShellViewRef } from '@orca/expo-mobile-web-shell'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

vi.mock('../host-route-exit', () => ({ leaveHostRoute: vi.fn() }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: vi.fn() }))

const REQUEST_ID = 'D'.repeat(22)

function renderNavigationAuthority(routeHandoff: MobileWebNativeRouteHandoff): {
  current: MobileWebNavigationAuthority | undefined
} {
  const authority: { current: MobileWebNavigationAuthority | undefined } = { current: undefined }
  function Probe(): null {
    authority.current = useMobileWebNavigationAuthority({
      hostId: 'shell-host',
      hostPublicKeyB64: 'shell-key',
      routeHandoffRef: { current: routeHandoff },
      router: { dismissTo: vi.fn(), push: vi.fn() },
      clearColdResumeRoute: vi.fn(),
      closeHostClient: vi.fn(),
      forceReconnectHost: vi.fn()
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  return authority
}

describe('hosted network diagnostics route', () => {
  it('reaches the shell connection log instead of a hosted route', async () => {
    const routeHandoff = new MobileWebNativeRouteHandoff()
    const authority = renderNavigationAuthority(routeHandoff)
    const { broker, client, pageMessages } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS],
      createRequestId: () => REQUEST_ID,
      isConnected: () => false,
      navigationAuthority: {
        route: (destination, requestId) => authority.current?.route(destination, requestId),
        reconnect: vi.fn(),
        removeHost: vi.fn()
      }
    })

    webHostScreenShellOperations(client, vi.fn()).openConnectionDiagnostics()
    await vi.waitFor(() => expect(pageMessages).toHaveLength(1))

    const pushed: string[] = []
    const deactivateSessionView = vi.fn().mockResolvedValue(undefined)
    await handleMobileWebBrokerMessage({
      message: pageMessages[0]!,
      brokerRef: { current: broker },
      activeSessionIdRef: { current: 'session' },
      sessionId: 'session',
      viewRef: { current: { deactivateSessionView } as unknown as MobileWebShellViewRef },
      routeHandoff,
      setHostedViewActive: vi.fn(),
      navigateToNativeRoute: (destination) => pushed.push(destination),
      onNavigationFailure: vi.fn()
    })

    await vi.waitFor(() => expect(pushed).toEqual(['connectionLog']))
    expect(deactivateSessionView).toHaveBeenCalledWith()
  })

  it('leaves the hosted route before the unpair deletes the package cache it serves', async () => {
    const order: string[] = []
    vi.mocked(leaveHostRoute).mockImplementation(() => {
      order.push('leave-route')
    })
    vi.mocked(removeHostAndCloseClient).mockImplementation(async () => {
      order.push('remove-host')
    })
    const authority = renderNavigationAuthority(new MobileWebNativeRouteHandoff())

    await authority.current?.removeHost()

    expect(order).toEqual(['leave-route', 'remove-host'])
  })

  it('leaves the host picker exit on the page-local route path', () => {
    const routeHandoff = new MobileWebNativeRouteHandoff()
    const authority = renderNavigationAuthority(routeHandoff)

    authority.current?.route('hostPicker', REQUEST_ID)

    expect(routeHandoff.consume(REQUEST_ID)).toBeNull()
  })
})
