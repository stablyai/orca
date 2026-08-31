import { describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'

describe('TerminalHost process inspection', () => {
  it('publishes process evidence with daemon inspection results', async () => {
    let onExit: ((code: number) => void) | undefined
    const emitExit = (): void => onExit?.(0)
    const subprocess = {
      pid: 99999,
      getForegroundProcess: vi.fn(() => 'codex'),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(emitExit),
      terminateOwnedTree: vi.fn(() => 'unavailable'),
      forceKill: vi.fn(emitExit),
      signal: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((callback: (code: number) => void) => {
        onExit = callback
      }),
      dispose: vi.fn()
    }
    const host = new TerminalHost({ spawnSubprocess: vi.fn(() => subprocess) as never })

    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    expect(host.inspectProcess('session-1')).toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      processEvidence: {
        foreground: { verdict: 'live', processName: 'codex' },
        children: { verdict: 'live' }
      }
    })
    await host.dispose()
  })
})
