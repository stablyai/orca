import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostConnectionState } from '../../shared/wsl-host-types'
import type { WslHostReachability } from './wsl-host-connector-contract'
import { WslHostPhoneGate } from './wsl-host-phone-reach'
import type { WslOrcadConnection } from './wsl-orcad-connection-types'

const STOPPED =
  'The WSL host Ubuntu isn’t running. Open one of its projects on your computer to start it.'
const NEUTRAL =
  'The WSL host Ubuntu isn’t available from your phone right now. Open one of its projects on your computer to connect it.'

const BRIDGE: WslOrcadConnection = {
  distro: 'Ubuntu',
  environmentId: 'wsl:ubuntu',
  localPort: 1,
  remotePort: 1,
  fullVersion: 'test',
  pid: null,
  pairingOffer: '',
  deferredUpdate: null,
  close: async () => {}
}

type Status = { environmentId: string; state: WslHostConnectionState }

function makeGate() {
  const state: {
    enabled: boolean
    bridged: boolean
    pendingStop: boolean
    removed: boolean
    reachability: WslHostReachability
  } = {
    enabled: true,
    bridged: true,
    pendingStop: false,
    removed: false,
    reachability: 'available'
  }
  // The board stores each published status object; identity changes with every publish.
  const board = new Map<string, Status>()
  const publish = (environmentId: string, hostState: WslHostConnectionState): void => {
    board.set(environmentId, { environmentId, state: hostState })
  }
  publish('wsl:ubuntu', 'reconnecting')
  publish('wsl:debian', 'ready')
  const reachability = vi.fn(async () => state.reachability)
  const gate = new WslHostPhoneGate({
    statuses: () => [...board.values()],
    records: () => [
      ...(state.removed
        ? []
        : [
            {
              environmentId: 'wsl:ubuntu',
              distro: 'Ubuntu',
              ...(state.pendingStop
                ? { pendingStop: { since: 1, reason: 'remove', verdict: 'live' as const } }
                : {})
            }
          ]),
      { environmentId: 'wsl:debian', distro: 'Debian' }
    ],
    connector: { get: () => (state.bridged ? BRIDGE : null), reachability },
    isEnabled: () => state.enabled,
    hasServerFiles: () => true
  })
  const confirmStop = async (): Promise<void> => {
    state.reachability = 'stopped'
    await expect(gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toMatchObject({
      message: STOPPED
    })
  }
  return { gate, state, board, publish, reachability, confirmStop }
}

describe('a paired phone and the WSL host', () => {
  let made: ReturnType<typeof makeGate>
  beforeEach(() => {
    made = makeGate()
  })

  it('says the host stopped only when the running list confirmed it', async () => {
    for (const unconfirmed of ['unavailable', 'unreachable'] as const) {
      made.state.reachability = unconfirmed
      await expect(made.gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toMatchObject({
        code: 'remote_runtime_unavailable',
        message: NEUTRAL
      })
      expect(made.gate.reach('wsl:ubuntu')).toBe('unavailable')
    }
    await made.confirmStop()
    expect(made.gate.reach('wsl:ubuntu')).toBe('stopped')
  })

  it("keeps a host's stop through another host's status changes", async () => {
    await made.confirmStop()
    made.publish('wsl:debian', 'reconnecting')
    made.publish('wsl:debian', 'ready')
    expect(made.gate.reach('wsl:ubuntu')).toBe('stopped')
  })

  it('drops a stop once the host publishes anything: ready, a disable or a failed Remove', async () => {
    for (const next of ['ready', 'closed'] as const) {
      await made.confirmStop()
      made.publish('wsl:ubuntu', next)
      expect(made.gate.reach('wsl:ubuntu')).toBe(next === 'ready' ? 'ready' : 'unavailable')
      made.publish('wsl:ubuntu', 'reconnecting')
    }
  })

  it('records a later stop again after the host was ready in between', async () => {
    await made.confirmStop()
    made.publish('wsl:ubuntu', 'ready')
    made.publish('wsl:ubuntu', 'closed')
    await made.confirmStop()
    expect(made.gate.reach('wsl:ubuntu')).toBe('stopped')
  })

  it('never lets a stopped read outrank a ready status, alone or shared by overlapping calls', async () => {
    let finish: (value: WslHostReachability) => void = () => {}
    const shared = new Promise<WslHostReachability>((resolve) => (finish = resolve))
    made.reachability.mockImplementation(() => shared)
    const early = made.gate.requireRunningWithoutStart('wsl:ubuntu')
    made.publish('wsl:ubuntu', 'ready')
    // Joins the read begun before ready.
    const late = made.gate.requireRunningWithoutStart('wsl:ubuntu')
    finish('stopped')
    await expect(early).rejects.toMatchObject({ message: NEUTRAL })
    await expect(late).rejects.toMatchObject({ message: NEUTRAL })
    expect(made.gate.reach('wsl:ubuntu')).toBe('ready')
  })

  it('clears a recorded stop once a check finds the host answering', async () => {
    await made.confirmStop()
    made.state.reachability = 'available'
    await made.gate.requireRunningWithoutStart('wsl:ubuntu')
    expect(made.gate.reach('wsl:ubuntu')).toBe('unavailable')
  })

  it('forgets a stop with the removed host', async () => {
    await made.confirmStop()
    made.state.removed = true
    expect(made.gate.reachAll().has('wsl:ubuntu')).toBe(false)
    made.state.removed = false
    expect(made.gate.reach('wsl:ubuntu')).toBe('unavailable')
  })
})
