import type { TerminalForegroundSample } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import '../../pty-subprocess/testing/mock-descendant-sweep'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { TerminalHost } from '../terminal-host'

function createSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn()
  }
}

describe('fresh foreground observation contract', () => {
  it('returns no child-census proof and fences a session replaced during its read', async () => {
    let finish!: (sample: TerminalForegroundSample) => void
    const subprocess = createSubprocess()
    subprocess.observeForeground = vi.fn(
      () =>
        new Promise<TerminalForegroundSample>((resolve) => {
          finish = resolve
        })
    )
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    const created = await host.createOrAttach({
      sessionId: 'foreground-contract',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    try {
      const pending = host.inspectProcess('foreground-contract', {
        foregroundOnly: true,
        expectedIncarnationId: created.incarnationId
      })
      finish({
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude'
      })
      expect(await pending).toMatchObject({
        foregroundProcess: 'claude',
        hasChildProcesses: true,
        childProcessEvidence: 'unverifiable',
        foregroundObservation: {
          ptyId: 'foreground-contract',
          ptyIncarnationId: created.incarnationId,
          verdict: 'observed'
        }
      })
      const late = host.inspectProcess('foreground-contract', { foregroundOnly: true })
      await host.kill('foreground-contract')
      finish({
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude'
      })
      expect(await late).toMatchObject({
        foregroundProcess: null,
        hasChildProcesses: true,
        foregroundObservation: { verdict: 'unverifiable', reason: 'session_changed' }
      })
    } finally {
      await host.dispose()
    }
  })
})
