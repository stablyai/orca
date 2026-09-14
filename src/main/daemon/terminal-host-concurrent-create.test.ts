import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

type MockSubprocess = SubprocessHandle & {
  emitData: (data: string) => void
  emitExit: (code: number) => void
}

function mockSubprocess(
  options: { confirmShellForeground?: () => Promise<boolean> } = {}
): MockSubprocess {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 4242,
    getForegroundProcess: vi.fn(() => null),
    ...(options.confirmShellForeground
      ? { confirmShellForeground: options.confirmShellForeground }
      : {}),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 1)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    emitData(data) {
      onDataCb?.(data)
    },
    emitExit(code) {
      onExitCb?.(code)
    }
  } as MockSubprocess
}

const streamClient = { onData: vi.fn(), onExit: vi.fn() }

function createOptions(sessionId: string) {
  return { sessionId, cols: 80, rows: 24, streamClient }
}

describe('concurrent createOrAttach across the async spawn', () => {
  it('spawns one shell when two callers race the same session id', async () => {
    // Both callers reach the async spawn before either can publish the session.
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const spawnSubprocess = vi.fn(async () => {
      await spawnGate
      return mockSubprocess()
    })
    const host = new TerminalHost({ spawnSubprocess })

    const first = host.createOrAttach(createOptions('race-1'))
    const second = host.createOrAttach(createOptions('race-1'))
    releaseSpawn()
    const results = await Promise.all([first, second])

    expect(spawnSubprocess).toHaveBeenCalledOnce()
    expect(results.map((result) => result.isNew).sort()).toEqual([false, true])
    expect(host.listSessions()).toHaveLength(1)

    await host.dispose()
  })

  it('attaches immediately while an ownership proof is still in flight', async () => {
    // The proof never resolves: attach must not wait on it. The viewer takes
    // the pre-reset snapshot and the in-stream reset heals its first frame.
    const first = mockSubprocess({
      confirmShellForeground: vi.fn(() => new Promise<boolean>(() => {}))
    })
    const spawnSubprocess = vi
      .fn<() => Promise<SubprocessHandle>>()
      .mockResolvedValueOnce(first)
      .mockImplementation(async () => mockSubprocess())
    const host = new TerminalHost({ spawnSubprocess })
    await host.createOrAttach(createOptions('settle-free'))
    first.emitData('\x1b[?1049hTUI\x1b]133;D;137\x07')
    await vi.waitFor(() => expect(first.confirmShellForeground).toHaveBeenCalledOnce())

    await expect(host.createOrAttach(createOptions('settle-free'))).resolves.toMatchObject({
      isNew: false
    })
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('lets the next caller spawn after a failed spawn releases the gate', async () => {
    const spawnSubprocess = vi
      .fn<() => Promise<SubprocessHandle>>()
      .mockRejectedValueOnce(new Error('Working directory "X" does not exist.'))
      .mockImplementation(async () => mockSubprocess())
    const host = new TerminalHost({ spawnSubprocess })

    await expect(host.createOrAttach(createOptions('race-2'))).rejects.toThrow('does not exist')
    // A failed spawn must leave the id claimable.
    await expect(host.createOrAttach(createOptions('race-2'))).resolves.toMatchObject({
      isNew: true
    })

    expect(spawnSubprocess).toHaveBeenCalledTimes(2)

    await host.dispose()
  })

  it('keeps distinct session ids spawning in parallel', async () => {
    let pendingSpawns = 0
    let maxConcurrent = 0
    const spawnSubprocess = vi.fn(async () => {
      pendingSpawns += 1
      maxConcurrent = Math.max(maxConcurrent, pendingSpawns)
      await new Promise((resolve) => setTimeout(resolve, 5))
      pendingSpawns -= 1
      return mockSubprocess()
    })
    const host = new TerminalHost({ spawnSubprocess })

    await Promise.all([
      host.createOrAttach(createOptions('solo-a')),
      host.createOrAttach(createOptions('solo-b'))
    ])

    // Global serialization would recreate the cross-session stall.
    expect(maxConcurrent).toBe(2)

    await host.dispose()
  })

  it('lets a canceled caller stop waiting on a create stuck on a dead share', async () => {
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        await spawnGate
        return mockSubprocess()
      }
    })

    const stuck = host.createOrAttach(createOptions('dead-share-session'))
    const abort = new AbortController()
    const queued = host.createOrAttach({
      ...createOptions('dead-share-session'),
      cancelSignal: abort.signal
    })
    abort.abort()

    // Without this the queued caller waits out the hung probe, holding a create
    // in flight and blocking shutdown/idle behind it.
    await expect(queued).rejects.toThrow('Attach canceled')

    releaseSpawn()
    await stuck
    await host.dispose()
  })

  it('waits for an in-flight spawn before disposing its session', async () => {
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const subprocess = mockSubprocess()
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        await spawnGate
        return subprocess
      }
    })

    const creation = host.createOrAttach(createOptions('shutdown-race'))
    const disposal = host.dispose()
    let disposed = false
    void disposal.then(() => {
      disposed = true
    })

    await Promise.resolve()
    expect(disposed).toBe(false)

    releaseSpawn()
    await creation
    await disposal

    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(host.listSessions()).toEqual([])
  })

  it('fences a queued retry when shutdown overlaps a failed spawn', async () => {
    let rejectSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((_resolve, reject) => {
      rejectSpawn = () => reject(new Error('spawn failed'))
    })
    const spawnSubprocess = vi
      .fn<() => Promise<SubprocessHandle>>()
      .mockImplementationOnce(async () => {
        await spawnGate
        return mockSubprocess()
      })
      .mockImplementation(async () => mockSubprocess())
    const host = new TerminalHost({ spawnSubprocess })

    const first = host.createOrAttach(createOptions('shutdown-retry'))
    const queued = host.createOrAttach(createOptions('shutdown-retry'))
    const disposal = host.dispose()
    rejectSpawn()

    await expect(first).rejects.toThrow('spawn failed')
    await expect(queued).rejects.toThrow('Terminal host is shutting down')
    await disposal

    expect(spawnSubprocess).toHaveBeenCalledOnce()
    expect(host.listSessions()).toEqual([])
  })
})
