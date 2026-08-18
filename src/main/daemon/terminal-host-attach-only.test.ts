import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

describe('TerminalHost attach-only sessions', () => {
  let host: TerminalHost
  let spawnSubprocess: Mock<SpawnSubprocess>

  beforeEach(() => {
    spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      let onExit: ((code: number) => void) | undefined
      return {
        pid: 99999,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => onExit?.(0)),
        forceKill: vi.fn(() => onExit?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn((callback) => {
          onExit = callback
        }),
        dispose: vi.fn()
      } as SubprocessHandle
    })
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    await host.dispose()
  })

  it('attaches only to an existing stable session', async () => {
    await host.createOrAttach({
      sessionId: 'stable-pane-session',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    const result = await host.createOrAttach({
      sessionId: 'stable-pane-session',
      cols: 120,
      rows: 40,
      attachOnly: true,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    expect(result.isNew).toBe(false)
    expect(spawnSubprocess).toHaveBeenCalledOnce()
  })

  it('does not create when an attach-only stable session is absent', async () => {
    await expect(
      host.createOrAttach({
        sessionId: 'missing-stable-pane-session',
        cols: 80,
        rows: 24,
        attachOnly: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow('Session not found: missing-stable-pane-session')
    expect(spawnSubprocess).not.toHaveBeenCalled()
  })
})
