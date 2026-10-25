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
  it('proves ordinary Windows shell children and withholds proof if its original Session exits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const subprocess = createSubprocess()
    let exitDuringRead = false
    const inspectChildProcesses = vi.fn(async () => {
      if (exitDuringRead) {
        subprocess.kill()
      }
      return 'no-children' as const
    })
    const host = new TerminalHost({
      spawnSubprocess: () => ({
        ...subprocess,
        getForegroundProcess: () => 'powershell.exe',
        inspectChildProcesses
      })
    })
    try {
      const created = await host.createOrAttach({
        sessionId: 'exiting',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      await expect(
        host.inspectProcess('exiting', { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({
        foregroundProcess: 'powershell.exe',
        childProcessEvidence: 'no-children',
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'windows_ssh_foreground_unavailable'
        }
      })
      expect(inspectChildProcesses).toHaveBeenCalledOnce()
      exitDuringRead = true
      await expect(
        host.inspectProcess('exiting', { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({
        childProcessEvidence: 'unverifiable',
        foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'session_changed' }
      })
    } finally {
      await host.dispose()
      vi.restoreAllMocks()
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
