import './mock-descendant-sweep'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

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

describe('TerminalHost process inspection', () => {
  it('discards a foreground capture that finishes after its session exits', async () => {
    const subprocess = createSubprocess()
    const owner = {
      agent: 'codex',
      process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
    } as const
    let finish!: (value: typeof owner) => void
    subprocess.captureAgentPresence = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    try {
      await host.createOrAttach({
        sessionId: 'session-presence',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const capture = host.captureAgentPresence('session-presence')
      subprocess.kill()
      finish(owner)
      expect(await capture).toBeUndefined()
    } finally {
      await host.dispose()
    }
  })

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
})
