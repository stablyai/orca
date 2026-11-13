import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge/bridge-port-pair-test-harness'
import { routeViewOf } from './page-route-policy'

describe('the session pane return grant', () => {
  it('reaches a page whose route declares only navigate', async () => {
    const routes = [
      { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'haptics'] },
      { pathname: '/h/[hostId]/source-control/[worktreeId]', grants: ['navigate'] }
    ]
    const pathname = '/h/host-a/source-control/wt-a'
    const view = routeViewOf(routes, pathname)
    const pair = createFakeBridgePortPair({
      route: { pathname },
      pageRoutes: view.pageRoutes,
      pageRouteGrants: view.pageRouteGrants,
      routeGrants: view.routeGrants
    })
    await pair.flush()

    const granted = pair.client.getShellSession()?.grants.native
    expect(granted).toContain('sessionPaneReturn')
    expect(granted).toContain('navigate')
    // The route did not declare it, so the harness default of every shell grant is not in play.
    expect(granted).not.toContain('haptics')
  })
})
