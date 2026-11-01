import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { getHistorySessionDirName } from './history-paths'
import type * as DaemonHealthModule from './daemon-health'

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: vi.fn(async () => 'unknown')
  }
})

it('drains keepHistory shutdowns admitted before connection preparation completes', async () => {
  const subprocess = createMockSubprocess()
  const harness = await startDaemonAdapterHarness(() => subprocess)
  const historyDir = join(harness.dir, 'history')
  const adapter = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: historyDir
  })
  try {
    const { id } = await adapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'sleep-admitted-before-preparation'
    })
    subprocess._simulateData('admitted sleep output\r\n')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected members match the adapter declarations; only connection preparation is gated.
    const internals = adapter as unknown as {
      ensureConnected(deadlineMs?: number): Promise<void>
      keepHistoryShutdowns: Set<Promise<void>>
    }
    const originalEnsureConnected = internals.ensureConnected.bind(adapter)
    let releasePreparation!: () => void
    const preparationRelease = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    vi.spyOn(internals, 'ensureConnected').mockImplementationOnce(async (deadlineMs) => {
      await preparationRelease
      await originalEnsureConnected(deadlineMs)
    })

    const shuttingDown = adapter.shutdown(id, { immediate: true, keepHistory: true })
    const admittedBeforeYield = internals.keepHistoryShutdowns.size
    const disconnecting = adapter.disconnectOnly()
    const operations = Promise.allSettled([shuttingDown, disconnecting])
    try {
      expect(admittedBeforeYield).toBe(1)
      await expect(adapter.shutdown(id, { immediate: true, keepHistory: true })).rejects.toThrow(
        'Cannot keep history after daemon disconnect has started'
      )
    } finally {
      releasePreparation()
      await operations
    }

    expect(await operations).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined }
    ])
    expect(internals.keepHistoryShutdowns.size).toBe(0)
    expect(adapter.getActiveSessionIds()).not.toContain(id)
    const sessionDir = join(historyDir, getHistorySessionDirName(id))
    const checkpoint = JSON.parse(readFileSync(join(sessionDir, 'checkpoint.json'), 'utf-8'))
    expect(checkpoint.snapshotAnsi).toContain('admitted sleep output')
    expect(JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8')).endedAt).toBeNull()
  } finally {
    adapter.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  }
})
