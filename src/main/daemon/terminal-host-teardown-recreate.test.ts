import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

// Keep fake PIDs away from real process probes and taskkill.
const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']
type ExitableSubprocess = SubprocessHandle & { exit: (code: number) => void }

/** Hold teardown until delayed exit; expose handles so tests can settle otherwise unkillable children. */
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
    // A create resuming after teardown must recheck shutdown before publishing.
    const disposed = host.dispose()

    await expect(create).rejects.toThrow('Terminal host is shutting down')
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    await killed
    await disposed
  })

  it('leaves a canceled create waiting on teardown instead of the full exit budget', async () => {
    // Keep teardown pending beyond the assertion to prove cancellation releases the create.
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
