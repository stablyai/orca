import { describe, expect, it, vi } from 'vitest'
import { rememberMobileWebBrokerRoute } from './mobile-web-broker-route-memory'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('broker route state authority', () => {
  it('forwards opaque state only with a live document and valid workspace binding', () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    authority.synchronize(['host-workspace'])
    const route = {
      kind: 'session' as const,
      workspaceId: authority.pageWorkspaceId('host-workspace'),
      workspaceName: 'Workspace'
    }
    const options = { rememberRoute: vi.fn(), rememberHostRoute: vi.fn() }
    const pageState = 'opaque state from a future page'
    rememberMobileWebBrokerRoute(false, route, authority, options, pageState)
    rememberMobileWebBrokerRoute(
      true,
      { ...route, workspaceId: 'retired-handle' },
      authority,
      options,
      pageState
    )
    expect(options.rememberRoute).not.toHaveBeenCalled()
    expect(options.rememberHostRoute).not.toHaveBeenCalled()
    rememberMobileWebBrokerRoute(true, route, authority, options, pageState)
    expect(options.rememberRoute).toHaveBeenCalledWith(route, pageState)
    expect(options.rememberHostRoute).toHaveBeenCalledWith({
      kind: 'session',
      hostWorkspaceId: 'host-workspace'
    })
  })
})
