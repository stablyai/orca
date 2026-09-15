import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

// A child that died before Session installed its listeners: the pre-listener buffer replays the
// exit synchronously inside `new Session(...)`, so the host's exit callback runs before the
// caller's `const session` binding exists. The callback must receive the exiting Session from
// Session itself, not close over that binding (review finding on stablyai/orca#20666).
function preExitedSubprocess(code: number): SubprocessHandle {
  return {
    pid: 4242,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    onData() {},
    onExit(cb) {
      cb(code)
    },
    dispose: vi.fn()
  }
}

describe('createOrAttach when the child exited before listeners were installed', () => {
  it('creates without throwing and tombstones the real exit code', async () => {
    const host = new TerminalHost({ spawnSubprocess: async () => preExitedSubprocess(3) })

    const created = await host.createOrAttach({
      sessionId: 'pre-exited',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    const inspection = await host.inspectProcess('pre-exited', {
      expectedIncarnationId: created.incarnationId
    })
    expect(inspection.foregroundProcessEvidence).toMatchObject({
      verdict: 'exited',
      reason: 'pty_exit_3'
    })

    await host.dispose()
  })
})
