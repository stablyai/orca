import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter shutdown incarnation fence', () => {
  let adapter: DaemonPtyAdapter
  let server: Awaited<ReturnType<typeof startDaemonAdapterHarness>>['server']
  let tempDir: string
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    adapter = harness.adapter
    server = harness.server
    tempDir = harness.dir
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('refuses over the wire to end a shell that is not the named incarnation', async () => {
    const sessionId = 'kill-fence'
    const spawned = await adapter.spawn({ cols: 80, rows: 24, sessionId })
    const live = lastSubprocess

    await expect(
      adapter.shutdown(sessionId, { immediate: true, expectedIncarnationId: 'an-older-shell' })
    ).rejects.toThrow('PTY incarnation mismatch')
    expect(live.kill).not.toHaveBeenCalled()
    expect(live.forceKill).not.toHaveBeenCalled()

    await adapter.shutdown(sessionId, {
      immediate: true,
      expectedIncarnationId: spawned.incarnationId
    })
    expect(live.forceKill).toHaveBeenCalled()
  })
})
