/** #29626: only the relay's proof that the last bridged terminal ended retries the waiting move. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { unusedSshConnection } from '../unused-host-transport.test-fixture'
import {
  ENDPOINT,
  type FakeRelay,
  fakeClient,
  lease,
  newFakeRelay,
  PTY,
  TARGET
} from './legacy-relay-fake-relay.test-fixture'
import {
  installLegacyRelayBridge,
  legacyRelayBridgedPanes,
  startLegacyRelayBridge
} from './legacy-relay-bridge-registry'
import {
  type BridgedMoveRetryDeps,
  onLastBridgedTerminalExit,
  retryMoveAfterLastBridgedExit
} from './legacy-relay-move-retry'

let relay: FakeRelay
let leases: SshRemotePtyLease[]
let lastExits: string[]

vi.mock('./legacy-relay-endpoints', () => ({
  listLegacyRelayEndpoints: async () => ({
    kind: 'listed',
    exhaustive: true,
    endpoints: [ENDPOINT]
  }),
  posixEndpointExited: async () => false
}))
vi.mock('./legacy-relay-client', () => ({
  LegacyRelayClient: {
    open: async () => {
      const client = fakeClient(relay)
      relay.clients.push(client)
      return client
    }
  }
}))

function startHost(): void {
  const connection = unusedSshConnection()
  installLegacyRelayBridge({
    leases: () => leases.filter((row) => row.state !== 'terminated'),
    retireLease: (_target, relayPtyId) => {
      leases = leases.map((row) =>
        row.ptyId === relayPtyId ? { ...row, state: 'terminated' } : row
      )
    },
    recordStop: () => {},
    connection: () => connection,
    onPanesChanged: () => {},
    onData: () => {},
    onReplay: () => {},
    onExit: () => {},
    report: () => {}
  })
}

beforeEach(() => {
  relay = newFakeRelay()
  leases = [lease()]
  lastExits = []
  onLastBridgedTerminalExit((targetId) => lastExits.push(targetId))
})

afterEach(() => {
  installLegacyRelayBridge(null)
  onLastBridgedTerminalExit(null)
})

describe('the last bridged relay terminal', () => {
  it('reports once when the relay proves the only pane exited', async () => {
    startHost()
    await startLegacyRelayBridge(TARGET)

    relay.ptys.delete('pty-1')
    relay.clients[0].emitExit('pty-1', 0)

    expect(lastExits).toEqual([TARGET])
    expect(legacyRelayBridgedPanes()).toEqual([])
  })

  it('never reports lost contact as exit', async () => {
    startHost()
    await startLegacyRelayBridge(TARGET)

    relay.clients[0].drop()

    expect(lastExits).toEqual([])
    expect(legacyRelayBridgedPanes()).toEqual([
      expect.objectContaining({ ptyId: PTY, state: 'unverifiable' })
    ])
  })

  it('waits for every bridged pane, not just the first to exit', async () => {
    leases = [lease(), lease({ ptyId: 'pty-2', tabId: 'tab-2', leafId: 'leaf-2' })]
    relay.ptys.add('pty-2')
    startHost()
    await startLegacyRelayBridge(TARGET)

    relay.ptys.delete('pty-1')
    relay.clients[0].emitExit('pty-1', 0)
    expect(lastExits).toEqual([])
    expect(legacyRelayBridgedPanes().map((pane) => pane.ptyId)).toEqual([
      toAppSshPtyId(TARGET, 'pty-2')
    ])

    relay.ptys.delete('pty-2')
    relay.clients[0].emitExit('pty-2', 0)
    expect(lastExits).toEqual([TARGET])
  })
})

function retryDeps(overrides: Partial<BridgedMoveRetryDeps> = {}): BridgedMoveRetryDeps {
  return {
    waitingOnBridgedTerminals: () => true,
    connectInFlight: () => undefined,
    connect: vi.fn(async () => {}),
    ...overrides
  }
}

describe('retrying the move', () => {
  it('runs one automatic connect even when exits overlap', async () => {
    let finish = (): void => {}
    const connect = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const deps = retryDeps({ connect })

    const first = retryMoveAfterLastBridgedExit(TARGET, deps)
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    await expect(retryMoveAfterLastBridgedExit(TARGET, deps)).resolves.toBe(false)
    finish()

    await expect(first).resolves.toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
