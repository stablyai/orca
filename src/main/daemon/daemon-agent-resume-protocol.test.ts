import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('daemon structured resume protocol', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSpawnOpts: unknown
  let subprocess: ReturnType<typeof createMockSubprocess>
  beforeEach(async () => {
    subprocess = createMockSubprocess()
    const harness = await startDaemonAdapterHarness((opts) => {
      lastSpawnOpts = opts
      return subprocess
    })
    ;({ dir, socketPath, tokenPath, server, adapter } = harness)
    lastSpawnOpts = null
  })
  afterEach(async () => {
    adapter.dispose()
    await server.shutdown()
    removeTreeSync(dir)
  })
  it('carries structured resume intent through the daemon RPC', async () => {
    const agentResume = {
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'session-1' },
      cmdOverrides: {}
    }
    await adapter.spawn({ cols: 80, rows: 24, command: 'preview', agentResume })
    expect(lastSpawnOpts).toMatchObject({ agentResume })
  })

  it.each([false, true])(
    'delivers the owner-built command only when absent from shell argv (%s)',
    async (inShellArgs) => {
      subprocess.startupCommand = 'codex "resume" "session-1"'
      subprocess.startupCommandDeliveredInShellArgs = inShellArgs
      // Why sh: a barrier-capable $SHELL (bash on CI) queues the write behind a
      // ready marker the mock never emits; sh keeps delivery immediate everywhere.
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: "codex 'resume' 'wrong-preview'",
        env: { SHELL: '/bin/sh' }
      })
      if (inShellArgs) {
        expect(subprocess.write).not.toHaveBeenCalled()
      } else {
        expect(subprocess.write).toHaveBeenCalledTimes(1)
        expect(subprocess.write.mock.calls[0][0]).toContain('codex "resume" "session-1"')
      }
    }
  )

  it('suppresses the legacy preview when the owner could not build a resume', async () => {
    await adapter.spawn({
      cols: 80,
      rows: 24,
      command: "codex 'resume' 'wrong-preview'",
      env: { SHELL: '/bin/sh' },
      agentResume: {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-1' },
        cmdOverrides: {}
      }
    })
    // The preview carries the requested shell's quoting; with no owner-built
    // command the host must write nothing rather than fall back to it.
    expect(subprocess.write).not.toHaveBeenCalled()
  })

  it('rejects structured resumes on an older daemon before creating a process', async () => {
    adapter.dispose()
    await server.shutdown()
    server = new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion: 36,
      spawnSubprocess: () => {
        throw new Error('Unexpected subprocess creation')
      }
    })
    await server.start()
    const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 36 })
    try {
      await expect(
        legacy.spawn({
          cols: 80,
          rows: 24,
          command: 'preview',
          agentResume: {
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' },
            cmdOverrides: {}
          }
        })
      ).rejects.toThrow(/resume/i)
      expect(lastSpawnOpts).toBeNull()
    } finally {
      legacy.dispose()
    }
  })
})
