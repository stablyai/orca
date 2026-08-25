import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter history-stop inventory', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    server = harness.server
    adapter = harness.adapter
  })

  afterEach(async () => {
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('retains exact authority when inventory overtakes a history-preserving exit', async () => {
    const spawned = await adapter.spawn({ cols: 80, rows: 24 })
    const internals = adapter as unknown as {
      activeSessionIds: Set<string>
      historyPreservingStopSessionIds: Set<string>
    }
    internals.historyPreservingStopSessionIds.add(spawned.id)
    lastSubprocess._simulateExit(0)
    internals.activeSessionIds.add(spawned.id)

    await adapter.listProcesses()

    expect(adapter.hasPty(spawned.id)).toBe(false)
    expect(adapter.getTerminalOwnerIdentity(spawned.id)).toEqual(spawned.ownerIdentity)
    await expect(
      adapter.probePtyLiveness(spawned.id, spawned.incarnationId, spawned.ownerIdentity)
    ).resolves.toBe(false)
  })
})
