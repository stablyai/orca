import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

/**
 * Why this test exists: the shell-ready barrier used to report a timeout with
 * console.warn, and the daemon is spawned detached with stdio 'ignore', so that
 * output reached nobody. The diagnostic looked present in code and was absent in
 * production. Asserting it at the barrier alone would not have caught that --
 * the callback has to survive every hop out to the daemon's file log.
 */
function createSubprocess(): SubprocessHandle & { exit: () => void } {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 4242,
    shellPath: '/opt/homebrew/bin/zsh',
    getForegroundProcess: () => 'zsh',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: (listener) => {
      onExit = listener
    },
    dispose: vi.fn(),
    exit: () => onExit?.(0)
  } as SubprocessHandle & { exit: () => void }
}

describe('TerminalHost readiness reporting', () => {
  let host: TerminalHost
  let subprocess: ReturnType<typeof createSubprocess> | undefined
  const events: { event: string; details: Record<string, unknown> }[] = []
  const spawnSubprocess = vi.fn(() => {
    subprocess = createSubprocess()
    return subprocess
  })

  beforeEach(() => {
    vi.useFakeTimers()
    events.length = 0
    spawnSubprocess.mockClear()
    host = new TerminalHost({
      spawnSubprocess,
      reportReadinessEvent: (event, details) => events.push({ event, details })
    })
  })

  afterEach(async () => {
    subprocess?.exit()
    await host.dispose()
    vi.useRealTimers()
  })

  it('delivers a shell-ready timeout out to the daemon log sink', async () => {
    await host.createOrAttach({
      sessionId: 'session-readiness',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() },
      shellReadySupported: true
    })

    vi.advanceTimersByTime(15_000)

    expect(events.map((entry) => entry.event)).toContain('shell-ready-timeout')
    const timeout = events.find((entry) => entry.event === 'shell-ready-timeout')
    expect(timeout?.details).toMatchObject({ sessionId: 'session-readiness', timeoutMs: 15_000 })
    // Why a basename: the shell path can carry a home dir, and the daemon log is
    // documented to hold terse fields only.
    expect(timeout?.details.shell).toBe('zsh')
  })
})
