import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter unnamed exit for an unpublished session', () => {
  let adapter: DaemonPtyAdapter
  let server: Awaited<ReturnType<typeof startDaemonAdapterHarness>>['server']
  let tempDir: string

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
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

  it('does not report a restored session as exited when a resize reaches the daemon before it exists', async () => {
    const sessionId = 'restored-session-resized-before-create'
    const client = adapter['client']
    const pendingSpawns = adapter['pendingSpawnOperationsBySessionId']
    const exits: { id: string; code: number }[] = []
    adapter.onExit((payload) => exits.push({ id: payload.id, code: payload.code }))
    const originalRequest = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (type, payload, ...rest) => {
      if (type === 'createOrAttach') {
        // The daemon answers a resize for an id it hasn't created with an exit naming no incarnation.
        adapter.resize(sessionId, 100, 30)
        await waitFor(() =>
          [...(pendingSpawns.get(sessionId) ?? [])].some(
            (operation) => (operation.exitsBySessionId.get(sessionId)?.length ?? 0) > 0
          )
        )
      }
      return await originalRequest(type, payload, ...rest)
    })

    const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.exitedBeforeSpawnReply).toBeUndefined()
    expect(result.incarnationId).toEqual(expect.any(String))
    expect(adapter.getActiveSessionIds()).toContain(sessionId)
    expect(exits).toEqual([])
  })
})
