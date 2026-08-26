import { describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

function createSubprocess() {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let resolveConfirm: ((confirmed: boolean) => void) | undefined
  const handle = {
    pid: 4242,
    getForegroundProcess: () => null,
    confirmShellForeground: vi.fn(
      () => new Promise<boolean>((resolve) => void (resolveConfirm = resolve))
    ),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    onData: (listener: (data: string) => void) => {
      onData = listener
    },
    onExit: (listener: (code: number) => void) => {
      onExit = listener
    },
    dispose: vi.fn()
  } as unknown as SubprocessHandle
  return {
    handle,
    emit: (data: string) => onData?.(data),
    exit: () => onExit?.(0),
    confirm: (v: boolean) => resolveConfirm?.(v)
  }
}

describe('createOrAttach cancellation during ownership settling', () => {
  it('does not steal the live viewer when the reattach was canceled mid-settle', async () => {
    const sub = createSubprocess()
    const host = new TerminalHost({ spawnSubprocess: async () => sub.handle })
    const liveData = vi.fn()
    const canceledData = vi.fn()
    await host.createOrAttach({
      sessionId: 's1',
      cols: 80,
      rows: 24,
      streamClient: { onData: liveData, onExit: vi.fn() }
    })

    // Open a recovery episode so the attach path's settle await actually pends.
    sub.emit('\x1b[?1049hTUI\x1b]133;D;137\x07')
    let canceled = false
    const reattach = host.createOrAttach({
      sessionId: 's1',
      cols: 80,
      rows: 24,
      streamClient: { onData: canceledData, onExit: vi.fn() },
      isCanceled: () => canceled
    })
    canceled = true
    sub.confirm(false)

    await expect(reattach).rejects.toThrow('Attach canceled for session s1')
    sub.emit('still-live')
    expect(liveData).toHaveBeenCalled()
    expect(canceledData).not.toHaveBeenCalled()

    sub.exit()
    await host.dispose()
  })

  it('respawns a fresh session when the shell exits during the settle await', async () => {
    const subs: ReturnType<typeof createSubprocess>[] = []
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        const sub = createSubprocess()
        subs.push(sub)
        return sub.handle
      }
    })
    await host.createOrAttach({
      sessionId: 's1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    // Open a recovery episode so the attach path's settle await actually pends,
    // then let the shell die behind the dead TUI — the pre-settle sync path
    // would have respawned here, never thrown SessionNotFoundError.
    subs[0]!.emit('\x1b[?1049hTUI\x1b]133;D;137\x07')
    const reattach = host.createOrAttach({
      sessionId: 's1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    subs[0]!.exit()
    subs[0]!.confirm(false)

    await expect(reattach).resolves.toMatchObject({ isNew: true })
    expect(subs).toHaveLength(2)

    subs[1]!.exit()
    await host.dispose()
  })
})
