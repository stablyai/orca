import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  daemonDiedRespawnMessage,
  takeLastDaemonExit,
  watchLaunchedDaemonExit
} from '../daemon-exit-record'

afterEach(() => {
  takeLastDaemonExit()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('daemon exit record (#39166)', () => {
  it('logs the exit signal and names it in the next respawn line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = new EventEmitter()
    watchLaunchedDaemonExit(child, 4242)

    child.emit('exit', null, 'SIGABRT')

    expect(warn).toHaveBeenCalledWith('[daemon] Daemon process 4242 exited: signal SIGABRT')
    expect(daemonDiedRespawnMessage()).toBe(
      '[daemon] Daemon process died (pid 4242, signal SIGABRT) — respawning'
    )
    // Consumed: a later death without an observed exit must not reuse it.
    expect(daemonDiedRespawnMessage()).toBe(
      '[daemon] Daemon process died (exit status not observed) — respawning'
    )
  })

  it('reports an exit code, and ignores an exit too old to explain this death', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = new EventEmitter()
    watchLaunchedDaemonExit(child, 7)
    child.emit('exit', 134, null)
    expect(daemonDiedRespawnMessage()).toContain('(pid 7, code 134)')

    vi.useFakeTimers({ now: 1_000_000 })
    const stale = new EventEmitter()
    watchLaunchedDaemonExit(stale, 8)
    stale.emit('exit', 0, null)
    expect(daemonDiedRespawnMessage(1_000_000 + 120_000)).toContain('exit status not observed')
  })

  it('forgets a predecessor exit once a replacement daemon launches', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const restarted = new EventEmitter()
    watchLaunchedDaemonExit(restarted, 11)
    restarted.emit('exit', null, 'SIGTERM')

    watchLaunchedDaemonExit(new EventEmitter(), 12)

    expect(daemonDiedRespawnMessage()).toContain('exit status not observed')
  })
})
