/**
 * Memory-leak regression: TerminalHost must reap dead sessions.
 *
 * SessionIds are minted fresh per pane and never reused, so a `TerminalHost`
 * that never removes exited sessions from its `sessions` map leaks one dead
 * `Session` — each pinning a `@xterm/headless` emulator with ~5000 rows of
 * scrollback — per terminal for the lifetime of the long-lived daemon process.
 *
 * The fix wires a Session `onExit` hook to `TerminalHost.reapSession`, which
 * disposes the emulator and drops the entry from the map. These tests assert the
 * emulator is disposed when a subprocess exits (before the fix it never was).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session'
import { HeadlessEmulator } from './headless-emulator'

function createMockSubprocess(): SubprocessHandle & {
  _onExitCb: ((code: number) => void) | null
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      setTimeout(() => onExitCb?.(0), 5)
    }),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    get _onDataCb() {
      return onDataCb
    },
    get _onExitCb() {
      return onExitCb
    }
  } as SubprocessHandle & { _onExitCb: ((code: number) => void) | null }
}

describe('TerminalHost dead-session reaping (leak regression)', () => {
  let host: TerminalHost
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let emulatorDispose: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    emulatorDispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    const spawnFn = vi.fn(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    host = new TerminalHost({ spawnSubprocess: spawnFn })
  })

  afterEach(() => {
    host.dispose()
    emulatorDispose.mockRestore()
  })

  function streamClient() {
    return { onData: vi.fn(), onExit: vi.fn() }
  }

  it('disposes the emulator and reaps the session when its subprocess exits', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    // Alive: emulator is held, not disposed.
    expect(emulatorDispose).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(1)

    // Natural exit.
    lastSubprocess._onExitCb?.(0)

    // The dead session's emulator (its scrollback buffer) is freed and the
    // session is gone from the map — not merely skipped by listSessions.
    expect(emulatorDispose).toHaveBeenCalledTimes(1)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('does not retain dead-session emulators across many create/exit cycles', async () => {
    const CYCLES = 5
    for (let i = 0; i < CYCLES; i++) {
      await host.createOrAttach({
        sessionId: `session-${i}`,
        cols: 80,
        rows: 24,
        streamClient: streamClient()
      })
      lastSubprocess._onExitCb?.(0)
    }

    // Every dead session was reaped: one emulator disposed per cycle, none retained.
    expect(emulatorDispose).toHaveBeenCalledTimes(CYCLES)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('reaps a session killed immediately (forceKill path)', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })

    host.kill('session-1', { immediate: true })

    // Emulator freed and session dropped from the map (no lingering dead entry).
    expect(emulatorDispose).toHaveBeenCalledTimes(1)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('reaps a session whose graceful kill times out (forceDispose path)', async () => {
    vi.useFakeTimers()
    try {
      const stubbornHost = new TerminalHost({
        spawnSubprocess: () => {
          const sub = createMockSubprocess()
          // Stubborn child: ignores graceful kill, so the KILL_TIMEOUT_MS timer
          // must force-dispose it.
          sub.kill = vi.fn()
          return sub
        }
      })
      await stubbornHost.createOrAttach({
        sessionId: 'stubborn',
        cols: 80,
        rows: 24,
        streamClient: streamClient()
      })

      // Graceful kill — the no-op subprocess.kill never fires onExit.
      stubbornHost.kill('stubborn')
      expect(emulatorDispose).not.toHaveBeenCalled()

      // The 5s KILL_TIMEOUT_MS fallback fires forceDispose, which disposes the
      // emulator and reaps the session via the onExit hook.
      vi.advanceTimersByTime(5000)

      expect(emulatorDispose).toHaveBeenCalledTimes(1)
      expect(stubbornHost.listSessions()).toHaveLength(0)
      stubbornHost.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
