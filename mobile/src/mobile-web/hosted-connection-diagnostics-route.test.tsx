import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { webHostScreenShellOperations } from '../worktree/web-host-screen-shell-operations'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS } from './mobile-web-production-navigation-grants'
import { useMobileWebNavigationAuthority } from './use-mobile-web-navigation-authority'
import { leaveHostRoute } from '../host-route-exit'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

vi.mock('../host-route-exit', () => ({ leaveHostRoute: vi.fn() }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: vi.fn() }))

function renderNavigationAuthority(): {
  current: MobileWebNavigationAuthority | undefined
} {
  const authority: { current: MobileWebNavigationAuthority | undefined } = { current: undefined }
  function Probe(): null {
    authority.current = useMobileWebNavigationAuthority({
      hostId: 'shell-host',
      hostPublicKeyB64: 'shell-key',
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
  it('opens the hosted route in place instead of handing the session to the shell', async () => {
    const navigate = vi.fn()
    const { client, pageMessages } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS],
      isConnected: () => false,
      navigationAuthority: { route: vi.fn(), reconnect: vi.fn(), removeHost: vi.fn() }
    })

    webHostScreenShellOperations(client, navigate).openConnectionDiagnostics()

    expect(navigate).toHaveBeenCalledWith('/connection-log')
    await Promise.resolve()
    expect(pageMessages).toHaveLength(0)
  })

  it('leaves the hosted route before the unpair deletes the package cache it serves', async () => {
    const order: string[] = []
    vi.mocked(leaveHostRoute).mockImplementation(() => {
      order.push('leave-route')
    })
    vi.mocked(removeHostAndCloseClient).mockImplementation(async () => {
      order.push('remove-host')
    })
    const authority = renderNavigationAuthority()

    await authority.current?.removeHost()

    expect(order).toEqual(['leave-route', 'remove-host'])
  })

  it('leaves the host picker exit on the page-local route path', () => {
    const authority = renderNavigationAuthority()

    authority.current?.route('hostPicker')

    expect(leaveHostRoute).toHaveBeenCalled()
  })
})
