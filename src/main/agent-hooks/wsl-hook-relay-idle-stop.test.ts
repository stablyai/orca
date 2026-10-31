import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WslBridgePtyPresence } from './wsl-bridge-pty-presence'
import { WslRelayIdleStop } from './wsl-hook-relay-idle-stop'
import type { WslRelayDistroState } from './wsl-hook-relay-state'
import type { DaemonBridgeSessionVerdict } from './wsl-bridge-daemon-sessions'

function running(distro = 'Ubuntu'): WslRelayDistroState {
  return {
    distro,
    phase: 'running',
    launchKinds: new Set(),
    failures: 0,
    cooldownUntil: 0,
    child: { kill: vi.fn() },
    codexHomePath: '/home/u/.codex'
  }
}

describe('the WSL hook relay idle stop', () => {
  let states: Map<string, WslRelayDistroState>
  let presence: WslBridgePtyPresence
  let idle: WslRelayIdleStop
  const clearRecoveryTimers = vi.fn()
  let daemon: DaemonBridgeSessionVerdict

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    states = new Map()
    presence = new WslBridgePtyPresence()
    clearRecoveryTimers.mockClear()
    daemon = 'none'
    idle = new WslRelayIdleStop({
      idleMs: 1_000,
      states,
      livePtyCount: (distro) => presence.count(distro),
      daemonBridgeSessions: async () => daemon,
      isDisposed: () => false,
      clearRecoveryTimers,
      warn: () => {}
    })
    presence.onChange((key) => idle.presenceChanged(key))
  })
  afterEach(() => vi.useRealTimers())

  it('counts hook traffic as activity, restarting the window', async () => {
    const state = running()
    states.set('ubuntu', state)
    idle.update(state)
    const ingest = vi.fn()
    const traffic = idle.noteTraffic(state, ingest)
    await vi.advanceTimersByTimeAsync(999)
    traffic({ paneKey: 'p' }, 'wsl:Ubuntu')
    expect(ingest).toHaveBeenCalledWith({ paneKey: 'p' }, 'wsl:Ubuntu')
    await vi.advanceTimersByTimeAsync(999)
    expect(states.has('ubuntu')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(states.has('ubuntu')).toBe(false)
    expect(state.child?.kill).toHaveBeenCalledOnce()
    expect(clearRecoveryTimers).toHaveBeenCalledWith(state)
  })

  it('arms only when the last bridge terminal of the distro goes, and only for that distro', async () => {
    const ubuntu = running()
    const debian = running('Debian')
    states.set('ubuntu', ubuntu)
    states.set('debian', debian)
    presence.noteLive('pty-1', 'Ubuntu')
    presence.noteLive('pty-2', 'ubuntu')
    presence.noteLive('pty-3', 'Debian')
    presence.noteExited('pty-1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(states.has('ubuntu')).toBe(true)

    presence.noteExited('pty-2')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(states.has('ubuntu')).toBe(false)
    expect(states.has('debian')).toBe(true)
  })

  // Review of #35173: a WSL shell whose distro the spawn didn't report still uses a relay.
  it('keeps every relay while a WSL terminal of unknown distro is open', async () => {
    const ubuntu = running()
    states.set('ubuntu', ubuntu)
    presence.noteLive('pty-1', null)
    idle.update(ubuntu)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(states.has('ubuntu')).toBe(true)

    presence.noteExited('pty-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(states.has('ubuntu')).toBe(false)
  })

  // Review of #35173: after a relaunch a hidden or headless bridge session is live in the daemon
  // though no pane noted it; orchestration or mobile may wake its agent.
  it("keeps a relay while the daemon still runs a bridge session there, or can't say", async () => {
    const state = running()
    states.set('ubuntu', state)
    for (const verdict of ['live', 'unverifiable'] as const) {
      daemon = verdict
      idle.update(state)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(states.get('ubuntu')).toBe(state)
    }

    daemon = 'none'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(states.has('ubuntu')).toBe(false)
  })

  it('brings a stopped relay back with its config, and a quit forgets it', async () => {
    const state = running()
    states.set('ubuntu', state)
    idle.update(state)
    await vi.advanceTimersByTimeAsync(1_000)

    idle.restoreParked('Ubuntu')
    expect(states.get('ubuntu')).toMatchObject({
      phase: 'failed',
      cooldownUntil: 0,
      codexHomePath: '/home/u/.codex'
    })

    states.clear()
    const again = running()
    states.set('ubuntu', again)
    idle.update(again)
    await vi.advanceTimersByTimeAsync(1_000)
    idle.dispose(true)
    idle.restoreParked('Ubuntu')
    expect(states.has('ubuntu')).toBe(false)
  })

  it('never stops a relay that is not running, or one a newer state replaced', async () => {
    const starting = { ...running(), phase: 'starting' as const }
    states.set('ubuntu', starting)
    idle.update(starting)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(states.get('ubuntu')).toBe(starting)

    const old = running()
    idle.update(old)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(states.get('ubuntu')).toBe(starting)
    expect(old.child?.kill).not.toHaveBeenCalled()
  })
})
