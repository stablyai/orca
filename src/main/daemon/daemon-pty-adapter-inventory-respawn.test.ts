import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('inventory after the terminal host dies (#10087)', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let respawnServer: DaemonServer | undefined

  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
  })
  afterEach(async () => {
    harness.adapter.dispose()
    await respawnServer?.shutdown()
    await harness.server.shutdown().catch(() => {})
    respawnServer = undefined
  })

  const healingAdapter = (): { adapter: DaemonPtyAdapter; respawn: ReturnType<typeof vi.fn> } => {
    const respawn = vi.fn(async () => {
      respawnServer = new DaemonServer({
        socketPath: harness.socketPath,
        tokenPath: harness.tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await respawnServer.start()
    })
    return {
      adapter: new DaemonPtyAdapter({
        socketPath: harness.socketPath,
        tokenPath: harness.tokenPath,
        respawn
      }),
      respawn
    }
  }

  it('lists processes after the host dies instead of failing the removal', async () => {
    // Dead host pipes previously blocked worktree removal until the app restarted (#10087).
    const { adapter, respawn } = healingAdapter()
    try {
      await adapter.spawn({ cols: 80, rows: 24 })
      await harness.server.shutdown()

      const processes = await adapter.listProcesses()

      expect(Array.isArray(processes)).toBe(true)
      expect(respawn).toHaveBeenCalled()
    } finally {
      adapter.dispose()
    }
  })

  it('still recovers on spawn, the path that already worked', async () => {
    const { adapter, respawn } = healingAdapter()
    try {
      await adapter.spawn({ cols: 80, rows: 24 })
      await harness.server.shutdown()

      await adapter.spawn({ cols: 80, rows: 24 })

      expect(respawn).toHaveBeenCalled()
    } finally {
      adapter.dispose()
    }
  })
})
