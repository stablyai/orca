/**
 * Journey 4 — two distinct final-host connections live at the same time, and one
 * host's delivery failure may not reach the other host or a sibling PTY.
 *
 * Everything below SSH is real: two `SshRelaySession`s, two real
 * `SshChannelMultiplexer`s, two real `SshPtyProvider`s, and two real
 * `RelayDispatcher`s speaking the relay wire over an in-process pipe. The fault
 * is injected the way a desynced relay actually produces it — a `pty.data`
 * frame whose source header does not parse, with a delivery identity the host
 * cannot cancel — so the whole rejection/recovery machinery runs for real.
 *
 * The oracle is the blast radius of exhausting ONE PTY's delivery-recovery
 * budget: the shared relay channel, the sibling PTY on the same host, and the
 * entire second host must be untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Store } from '../persistence'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import { RelayDispatcher } from '../../relay/dispatcher'
import { getSshPtyProvider, unregisterSshPtyProvider } from '../ipc/pty'
import type { SshPtyProvider } from '../providers/ssh-pty-provider'
import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../../shared/pty-source-credit-contract'
import {
  installSshPtyOutputIntake,
  type acceptSshPtyOutputData
} from '../ipc/ssh-pty-output-intake-registry'
import type { SshPtyOutputIntake } from '../ipc/ssh-pty-output-intake'

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const { SshRelaySession } = await import('./ssh-relay-session')

type DeliveredFrame = Parameters<typeof acceptSshPtyOutputData>[0]

/** The relay-side half of one host: a real dispatcher plus wire-level controls. */
type FakeRelayHost = {
  transport: MultiplexerTransport
  dispatcher: RelayDispatcher
  /** Publishes output on the PTY's live delivery, advancing its source cursor. */
  publish: (relayPtyId: string, data: string) => void
  /**
   * Publishes a frame whose source header does not parse (`sourceLengthSu`
   * disagrees with the payload) but which still carries a complete delivery
   * identity this client never installed. That combination is what routes the
   * rejection into the bounded per-PTY recovery budget rather than an immediate
   * channel reconnect.
   */
  publishMalformed: (relayPtyId: string, data: string) => void
  requestCounts: Map<string, number>
  /** When true, `pty.attach` is refused — the relay cannot re-prove the delivery. */
  refuseAttach: { value: boolean }
  dispose: () => void
}

function createFakeRelayHost(): FakeRelayHost {
  const clientDataCallbacks: ((data: Buffer) => void)[] = []
  const clientCloseCallbacks: (() => void)[] = []
  const requestCounts = new Map<string, number>()
  const refuseAttach = { value: false }
  const deliveries = new Map<
    string,
    { deliveryToken: string; ptyIncarnation: string; sentSu: number }
  >()
  let spawnCount = 0

  const transport: MultiplexerTransport = {
    write: (data) => {
      setImmediate(() => dispatcher.feed(data))
    },
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: (cb) => {
      clientCloseCallbacks.push(cb)
    },
    close: () => {
      for (const cb of clientCloseCallbacks) {
        cb()
      }
    }
  }

  const dispatcher = new RelayDispatcher((data) => {
    setImmediate(() => {
      for (const cb of clientDataCallbacks) {
        cb(data)
      }
    })
  })

  const count = (method: string): void => {
    requestCounts.set(method, (requestCounts.get(method) ?? 0) + 1)
  }

  dispatcher.onRequest('pty.openClient', async (params) => {
    count('pty.openClient')
    return {
      protocolVersion: 1,
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      role: 'session-owner',
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease',
      resumed: params.resume !== undefined,
      capabilities: {
        outputFlowControl: { version: 1, windowSu: DEFAULT_PTY_SOURCE_WINDOW_SU }
      }
    }
  })
  dispatcher.onRequest('session.resolveHome', async (params) => ({
    resolvedPath: params.path === '~' ? '/home/orca' : params.path
  }))
  dispatcher.onRequest('git.listWorktrees', async () => [])
  dispatcher.onRequest('ports.detect', async () => ({ ports: [], platform: 'linux' }))
  dispatcher.onRequest('pty.spawn', async () => {
    count('pty.spawn')
    spawnCount += 1
    const id = `remote-pty-${spawnCount}`
    const ptyIncarnation = `incarnation-${id}`
    const deliveryToken = `delivery-${id}`
    deliveries.set(id, { deliveryToken, ptyIncarnation, sentSu: 0 })
    return {
      id,
      incarnationId: ptyIncarnation,
      sourceActivation: {
        status: 'pending',
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation,
        deliveryToken,
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      }
    }
  })
  dispatcher.onRequest('pty.getCwd', async () => {
    count('pty.getCwd')
    return '/home/orca/project'
  })
  // Why `canceled: false`: the host cannot retire a delivery identity it never
  // issued. That is the branch that asks the client to confirm the existing
  // delivery rather than to drop the channel, so recovery enters the bounded
  // retry budget this test is about.
  dispatcher.onRequest('pty.cancelDelivery', async () => {
    count('pty.cancelDelivery')
    return { canceled: false }
  })
  dispatcher.onRequest('pty.attach', async () => {
    count('pty.attach')
    if (refuseAttach.value) {
      // Why not a not-found error: not-found is positive proof the PTY is gone
      // and takes the destructive path. A refusal is the "unknown" case, which
      // is what keeps the recovery budget burning down.
      throw new Error('relay_attach_refused')
    }
    return { id: 'unused' }
  })

  const delivery = (relayPtyId: string) => {
    const state = deliveries.get(relayPtyId)
    if (!state) {
      throw new Error(`relay has no delivery for ${relayPtyId}`)
    }
    return state
  }

  return {
    transport,
    dispatcher,
    publish: (relayPtyId, data) => {
      const state = delivery(relayPtyId)
      state.sentSu += data.length
      dispatcher.notify('pty.data', {
        id: relayPtyId,
        data,
        deliveryToken: state.deliveryToken,
        ptyIncarnation: state.ptyIncarnation,
        clientGeneration: 1,
        ownerGeneration: 1,
        sourceEndSu: state.sentSu,
        sourceLengthSu: data.length
      })
    },
    publishMalformed: (relayPtyId, data) => {
      dispatcher.notify('pty.data', {
        id: relayPtyId,
        data,
        deliveryToken: 'delivery-this-client-never-installed',
        ptyIncarnation: 'incarnation-unknown',
        clientGeneration: 1,
        ownerGeneration: 1,
        sourceEndSu: data.length + 1,
        sourceLengthSu: data.length + 1
      })
    },
    requestCounts,
    refuseAttach,
    dispose: () => dispatcher.dispose()
  }
}

function createStore(): Store {
  return {
    getRepos: vi.fn().mockReturnValue([]),
    getSshPtyConsumerRecovery: vi.fn().mockReturnValue(null),
    upsertSshPtyConsumerRecovery: vi.fn(),
    removeSshPtyConsumerRecovery: vi.fn(),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    supersedeDuplicatePaneLeases: vi.fn().mockReturnValue(0),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn(),
    markSshRemotePtyLeasesAsync: vi.fn(),
    markSshRemotePtyLeasesForShutdown: vi.fn(),
    markSshRemotePtyLeasesAttachedAsync: vi.fn(),
    persistPtyBinding: vi.fn().mockReturnValue(true)
  } as unknown as Store
}

type LiveHost = {
  targetId: string
  relay: FakeRelayHost
  session: InstanceType<typeof SshRelaySession>
  provider: SshPtyProvider
  relayLost: ReturnType<typeof vi.fn>
  terminalError: ReturnType<typeof vi.fn>
}

async function openHost(targetId: string): Promise<LiveHost> {
  const relay = createFakeRelayHost()
  vi.mocked(deployAndLaunchRelay).mockResolvedValue({
    transport: relay.transport,
    serverBuildId: 'test-relay-build',
    platform: 'linux-x64'
  })
  const session = new SshRelaySession(
    targetId,
    vi.fn().mockReturnValue({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { send: vi.fn() }
    }),
    createStore(),
    { removeAllForwards: vi.fn().mockResolvedValue(undefined) } as unknown as SshPortForwardManager
  )
  const relayLost = vi.fn()
  const terminalError = vi.fn()
  session.setOnRelayLost(relayLost)
  session.setOnTerminalRelayError(terminalError)
  await session.establish({} as SshConnection)
  const provider = getSshPtyProvider(targetId) as SshPtyProvider | undefined
  if (!provider) {
    throw new Error(`no PTY provider registered for ${targetId}`)
  }
  return { targetId, relay, session, provider, relayLost, terminalError }
}

describe('two live SSH hosts over real relay dispatchers', () => {
  const hosts: LiveHost[] = []
  let delivered: DeliveredFrame[] = []
  let uninstallIntake: (() => void) | null = null
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    delivered = []
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Why the real registration seam: the session publishes accepted output
    // through `acceptSshPtyOutputData`, so installing a recording intake
    // observes the production delivery boundary without stubbing the module.
    uninstallIntake = installSshPtyOutputIntake({
      acceptData: async (event) => {
        delivered.push(event)
        return { status: 'accepted' } as never
      },
      acceptExit: async () => {},
      closeGeneration: () => {},
      dispose: () => {}
    } as unknown as SshPtyOutputIntake)
  })

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      host.session.dispose()
      host.relay.dispose()
      unregisterSshPtyProvider(host.targetId)
    }
    uninstallIntake?.()
    uninstallIntake = null
    warnSpy.mockRestore()
  })

  /**
   * Brings both hosts up, gives host A two PTYs and host B one, proves all three
   * deliver, then burns host A's PTY-1 delivery-recovery budget to exhaustion.
   *
   * The two clauses are separate tests on purpose: a mutation that only breaks
   * same-host containment must be seen to leave the cross-host clause green,
   * which proves the clauses independently rather than jointly.
   */
  async function exhaustOnePtyOnHostA(): Promise<{
    hostA: LiveHost
    hostB: LiveHost
    a2: { id: string }
    b1: { id: string }
  }> {
    const hostA = await openHost('host-a')
    const hostB = await openHost('host-b')
    hosts.push(hostA, hostB)

    const a1 = await hostA.provider.spawn({ cols: 80, rows: 24, cwd: '/home/orca' })
    const a2 = await hostA.provider.spawn({ cols: 80, rows: 24, cwd: '/home/orca' })
    const b1 = await hostB.provider.spawn({ cols: 80, rows: 24, cwd: '/home/orca' })
    expect(a1.id).toBe(toAppSshPtyId('host-a', 'remote-pty-1'))
    expect(a2.id).toBe(toAppSshPtyId('host-a', 'remote-pty-2'))
    expect(b1.id).toBe(toAppSshPtyId('host-b', 'remote-pty-1'))
    // Two distinct final-host connections, each with its own provider identity.
    expect(hostA.provider).not.toBe(hostB.provider)

    hostA.relay.publish('remote-pty-1', 'a1-before')
    hostA.relay.publish('remote-pty-2', 'a2-before')
    hostB.relay.publish('remote-pty-1', 'b1-before')
    await vi.waitFor(() => expect(delivered).toHaveLength(3), { timeout: 5_000 })
    delivered = []

    // The fault: one PTY on host A can never re-prove its delivery.
    hostA.relay.refuseAttach.value = true
    hostA.relay.publishMalformed('remote-pty-1', 'a1-poisoned')
    await vi.waitFor(
      () =>
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('remote-pty-1 delivery recovery exhausted')
        ),
      { timeout: 60_000 }
    )
    // Why the extra settle: a channel drop is scheduled off the same recovery
    // pass that logs the exhaustion, not before it.
    await new Promise((resolve) => setTimeout(resolve, 500))

    // The budget was really spent on relay round trips, so the fault is live.
    expect(hostA.relay.requestCounts.get('pty.attach') ?? 0).toBeGreaterThanOrEqual(12)
    expect(hostA.relay.requestCounts.get('pty.cancelDelivery') ?? 0).toBeGreaterThan(0)
    // The undeliverable frame itself never reached a consumer.
    expect(delivered.some((frame) => frame.data === 'a1-poisoned')).toBe(false)

    return { hostA, hostB, a2, b1 }
  }

  it('leaves the sibling PTY and the shared channel on the same host working', async () => {
    const { hostA, a2 } = await exhaustOnePtyOnHostA()

    hostA.relay.publish('remote-pty-2', 'a2-after')
    await vi.waitFor(
      () =>
        expect(
          delivered.filter((frame) => frame.id === a2.id && frame.data === 'a2-after'),
          'the sibling PTY stopped receiving output after its neighbour was parked'
        ).toHaveLength(1),
      { timeout: 10_000 }
    )
    // A live request round trip: the shared channel still carries the fs/git
    // control plane that dropping it would have aborted.
    await expect(hostA.provider.getCwd(a2.id)).resolves.toBe('/home/orca/project')
    expect(hostA.relayLost, 'host A lost its relay channel over one PTY').not.toHaveBeenCalled()
    expect(hostA.terminalError, 'host A was parked in manual recovery').not.toHaveBeenCalled()
  }, 120_000)

  it('leaves the second host entirely untouched', async () => {
    const { hostB, b1 } = await exhaustOnePtyOnHostA()

    expect(hostB.relayLost, 'host B lost its relay channel').not.toHaveBeenCalled()
    expect(hostB.terminalError, 'host B was parked in manual recovery').not.toHaveBeenCalled()
    expect(
      hostB.relay.requestCounts.get('pty.attach') ?? 0,
      "host A's recovery reached host B's relay"
    ).toBe(0)
    expect(
      hostB.relay.requestCounts.get('pty.cancelDelivery') ?? 0,
      "host A's delivery cancellation reached host B's relay"
    ).toBe(0)
    expect(
      hostB.relay.requestCounts.get('pty.openClient') ?? 0,
      'host B renegotiated its consumer session'
    ).toBe(1)
    await expect(hostB.provider.getCwd(b1.id)).resolves.toBe('/home/orca/project')
    hostB.relay.publish('remote-pty-1', 'b1-after')
    await vi.waitFor(
      () =>
        expect(
          delivered.filter((frame) => frame.id === b1.id && frame.data === 'b1-after')
        ).toHaveLength(1),
      { timeout: 10_000 }
    )
  }, 120_000)
})
