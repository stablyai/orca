import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

describe('TerminalHost pending kill fences', () => {
  it('rejects a fenced pending kill after the session was reaped', async () => {
    let onExit: ((code: number) => void) | undefined
    let finishSweep!: () => void
    killWithDescendantSweepMock.mockImplementation(
      (_pid: number, finish: () => void) =>
        new Promise<void>((resolve) => {
          finishSweep = () => {
            finish()
            resolve()
          }
        })
    )
    const subprocess: SubprocessHandle = {
      pid: 99999,
      getForegroundProcess: () => null,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      forceKill: vi.fn(),
      terminateOwnedTree: () => 'unavailable',
      signal: vi.fn(),
      onData: vi.fn(),
      onExit: (callback) => {
        onExit = callback
      },
      dispose: vi.fn()
    }
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    try {
      await host.createOrAttach({
        sessionId: 'agent-reaped-fence',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const pending = host.kill('agent-reaped-fence', { immediate: true })
      onExit?.(0)
      await expect(
        host.kill('agent-reaped-fence', {
          immediate: true,
          incarnationId: 'stale-incarnation'
        })
      ).resolves.toEqual({ fenceUnavailable: true })

      finishSweep()
      await pending
    } finally {
      await host.dispose()
    }
  })

  it('preserves a replacement session when a stale pending kill is fenced out', async () => {
    let onExit: ((code: number) => void) | undefined
    const subprocess: SubprocessHandle = {
      pid: 99999,
      getForegroundProcess: () => null,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      forceKill: vi.fn(),
      terminateOwnedTree: () => 'unavailable',
      signal: vi.fn(),
      onData: vi.fn(),
      onExit: (callback) => {
        onExit = callback
      },
      dispose: vi.fn()
    }
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    const replacement = await host.createOrAttach({
      sessionId: 'replacement-fence',
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    await expect(
      host.kill('replacement-fence', {
        immediate: true,
        incarnationId: 'stale-incarnation'
      })
    ).resolves.toEqual({ fenceUnavailable: true })
    expect(host.listSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'replacement-fence',
        incarnationId: replacement.incarnationId
      })
    ])
    onExit?.(0)
  })
})
