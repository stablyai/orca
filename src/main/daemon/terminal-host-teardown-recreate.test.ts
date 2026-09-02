import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

// Why mocked: the win32 plain-shell teardown sweeps for real, and an unmocked run would put a
// live process-table probe -- and, on a recycled pid, a taskkill /T /F -- behind these tests.
const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']
type ExitableSubprocess = SubprocessHandle & { exit: (code: number) => void }

/** Shells that report their exit only after `exitDelayMs`, holding the teardown claim open the
 *  way a real one does while the Windows sweep probes and taskkills its tree. Collected so a test
 *  can retire an intentionally unkillable child instead of leaking its exit waiter. */
function spawnSubprocessWithSlowExit(exitDelayMs: number): {
  spawnSubprocess: Mock<SpawnSubprocess>
  handles: ExitableSubprocess[]
} {
  const handles: ExitableSubprocess[] = []
  const spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
    let onExit: ((code: number) => void) | undefined
    const handle = {
      pid: 4242,
      exit: (code: number) => onExit?.(code),
      getForegroundProcess: vi.fn(() => null),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        setTimeout(() => onExit?.(0), exitDelayMs).unref?.()
      }),
      terminateOwnedTree: () => 'unavailable' as const,
      forceKill: vi.fn(() => {
        setTimeout(() => onExit?.(137), exitDelayMs).unref?.()
      }),
      signal: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((callback) => {
        onExit = callback
      }),
      dispose: vi.fn()
    } as unknown as ExitableSubprocess
    handles.push(handle)
    return handle
  })
  return { spawnSubprocess, handles }
}

const streamClient = (): { onData: Mock; onExit: Mock } => ({
  onData: vi.fn(),
  onExit: vi.fn()
})

describe('TerminalHost recreate during teardown', () => {
  it('recreates a session whose id is still being torn down', async () => {
    const { spawnSubprocess } = spawnSubprocessWithSlowExit(40)
    const host = new TerminalHost({ spawnSubprocess })
    const sessionId = 'wt-1@@respawning-pane'
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: streamClient() })

    // The pane closes and immediately respawns onto its own stable id (#18046).
    const killed = host.kill(sessionId, { immediate: true })
    const recreated = await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })

    expect(recreated.isNew).toBe(true)
    expect(spawnSubprocess).toHaveBeenCalledTimes(2)
    await killed
    await host.dispose()
  })

  it('still refuses an attach-only respawn onto a session being torn down', async () => {
    const { spawnSubprocess } = spawnSubprocessWithSlowExit(40)
    const host = new TerminalHost({ spawnSubprocess })
    const sessionId = 'wt-1@@attaching-pane'
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: streamClient() })

    const killed = host.kill(sessionId, { immediate: true })
    // Why unchanged: adopting a doomed session would hand the pane a shell teardown owns; the
    // caller retires the pane binding on this error and spawns fresh.
    await expect(
      host.createOrAttach({
        sessionId,
        cols: 80,
        rows: 24,
        attachOnly: true,
        streamClient: streamClient()
      })
    ).rejects.toThrow(`Session not found: ${sessionId}`)
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    await killed
    await host.dispose()
  })

  it('refuses a create waiting on teardown once the host is shutting down', async () => {
    const { spawnSubprocess } = spawnSubprocessWithSlowExit(40)
    const host = new TerminalHost({ spawnSubprocess })
    const sessionId = 'wt-1@@shutting-down-pane'
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: streamClient() })

    const killed = host.kill(sessionId, { immediate: true })
    const create = host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    // Why: dispose joins pending creations, so a create that waited out teardown must re-read the
    // fence rather than publish a session nothing will shut down.
    const disposed = host.dispose()

    await expect(create).rejects.toThrow('Terminal host is shutting down')
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    await killed
    await disposed
  })

  it('leaves a canceled create waiting on teardown instead of the full exit budget', async () => {
    // Why a child that never exits on its own: the create must leave on its abort signal, not on
    // the teardown settling, so the teardown deliberately outlives the assertion.
    const { spawnSubprocess, handles } = spawnSubprocessWithSlowExit(30_000)
    const host = new TerminalHost({ spawnSubprocess })
    const sessionId = 'wt-1@@canceled-pane'
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: streamClient() })

    const killed = host.kill(sessionId, { immediate: true })
    const canceled = new AbortController()
    const create = host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      cancelSignal: canceled.signal,
      isCanceled: () => canceled.signal.aborted,
      streamClient: streamClient()
    })
    canceled.abort()

    await expect(create).rejects.toThrow(`Attach canceled for session ${sessionId}`)
    expect(spawnSubprocess).toHaveBeenCalledOnce()

    handles[0].exit(137)
    await killed
    await host.dispose()
  })
})
