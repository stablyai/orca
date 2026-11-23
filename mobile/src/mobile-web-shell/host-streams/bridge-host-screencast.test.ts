import { describe, expect, it } from 'vitest'
import { clientFrame } from '../test-support/bridge-host-test-fakes'
import { harness, ID } from '../test-support/bridge-host-test-harness'

const SCREENCAST = 'browser.screencast'

function screencastSubscribe(id: string, wantsBinary?: boolean): string {
  return clientFrame({
    type: 'subscribe',
    id,
    method: SCREENCAST,
    params: { worktree: 'id:w', page: 'p' },
    ...(wantsBinary === undefined ? {} : { wantsBinary })
  })
}

// Without the binary grant, keep serving JSON and report locally; never silently grant a lane the route did not request.
describe('the binary lane is served only to a route granted it', () => {
  // The resolved grant list omits both unimplemented and unrequested capabilities; page-route-policy.test.ts pins that filter.
  it('hands it none when the route was not, and still opens the stream', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: {
        native: [
          'fault',
          'rpcEnvelope',
          'hostCatalogs',
          'sessionPaneReturn',
          'chatVisualFrame',
          'navigate',
          'storage',
          'native.browser.local',
          'native.browser.view'
        ]
      }
    })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.diagnostics).toEqual([{ kind: 'binary-lane-refused', id: ID }])
    expect(bridge.client.streams[0]?.emitBinary).toBeNull()
    bridge.client.streams[0]?.emit({ type: 'ready' })
    expect(bridge.frames().filter((message) => message.type === 'event')).toHaveLength(1)
    expect(bridge.frames().filter((message) => message.type === 'error')).toEqual([])
  })

  it('says nothing about a page that never asked for the lane', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    bridge.host.receive(screencastSubscribe(ID))
    expect(bridge.diagnostics).toEqual([])
  })
})
