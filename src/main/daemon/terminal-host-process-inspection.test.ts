import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'
import { TerminalHost } from './terminal-host'

function createSubprocess(killExitCode = 0): SubprocessHandle {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(killExitCode)),
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

describe('TerminalHost process inspection', () => {
  it('returns unverifiable when the expected incarnation is stale', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => createSubprocess() })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-incarnation',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await expect(
        host.inspectProcess('session-incarnation', { expectedIncarnationId: 'replacement' })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch',
          ptyId: 'session-incarnation',
          ptyIncarnationId: created.incarnationId
        }
      })
    } finally {
      await host.dispose()
    }
  })

  // Residual A: a retired-incarnation tombstone must carry the same proof requirement as a live
  // read — an unproven code (contact lost, never vouched for) must never mint a clean 'exited'.
  it('never publishes a proven exit from a tombstone the host could not vouch for', async () => {
    const result = await inspectTerminalHostProcess({
      sessionId: 'session-tombstone',
      session: null,
      expectedIncarnationId: 'inc-1',
      retiredIncarnation: { incarnationId: 'inc-1', code: -1, expiresAt: Date.now() + 60_000 },
      authorityGeneration: 'gen-1',
      nextObservationEpoch: () => 1
    })

    expect(result.foregroundProcessEvidence).toMatchObject({
      verdict: 'unverifiable',
      reason: 'pty_exit_unverified',
      ptyIncarnationId: 'inc-1'
    })
  })

  it('still publishes a proven exit when the host vouched for a status', async () => {
    const result = await inspectTerminalHostProcess({
      sessionId: 'session-tombstone',
      session: null,
      expectedIncarnationId: 'inc-1',
      retiredIncarnation: { incarnationId: 'inc-1', code: 0, expiresAt: Date.now() + 60_000 },
      authorityGeneration: 'gen-1',
      nextObservationEpoch: () => 1
    })

    expect(result.foregroundProcessEvidence).toMatchObject({
      verdict: 'exited',
      reason: 'pty_exit_0',
      ptyIncarnationId: 'inc-1'
    })
  })

  // A1 wiring: the tombstone is built from the Session onSessionExit was called for, not a
  // re-lookup by id — this exercises the real terminal-host.ts -> terminal-host-session-create.ts
  // -> inspectProcess path end to end with an unverified exit code.
  it("threads the exiting session's own unverified exit code into its tombstone end to end", async () => {
    const host = new TerminalHost({ spawnSubprocess: () => createSubprocess(-1) })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-exit-wired',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await host.kill('session-exit-wired')

      await expect(
        host.inspectProcess('session-exit-wired', { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'pty_exit_unverified',
          ptyIncarnationId: created.incarnationId
        }
      })
    } finally {
      await host.dispose()
    }
  })
})
