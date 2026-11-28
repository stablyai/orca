import { expect, it } from 'vitest'
import { createBridgeClientShellSession } from './bridge-client-shell-session'

type Init = Parameters<ReturnType<typeof createBridgeClientShellSession>['accept']>[0]

function init(sessionId: string, ownsHostArea: boolean): Init {
  return {
    v: 1,
    type: 'init',
    sessionId,
    buildId: 'build',
    connection: {
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastInboundAt: null,
      generation: null
    },
    grants: { rpc: { maxPendingRequests: 1, maxSubscriptions: 1 }, native: [] },
    ...(ownsHostArea ? { ownsHostArea: true } : {})
  }
}

// A chat opened folded is handed the host area by the unfold's init, after the page re-rendered.
it('publishes a host-area change from a same-session or replacement init', () => {
  const session = createBridgeClientShellSession({ onReplaced: () => {}, prime: () => {} })
  const seen: boolean[] = []
  session.onHostAreaUpdate((owns) => seen.push(owns))

  session.accept(init('a', false))
  session.accept(init('a', true))
  expect(session.current()?.ownsHostArea).toBe(true)
  session.accept(init('a', true))
  session.accept(init('b', false))
  expect(session.current()?.ownsHostArea).toBe(false)
  expect(seen).toEqual([true, false])
})
