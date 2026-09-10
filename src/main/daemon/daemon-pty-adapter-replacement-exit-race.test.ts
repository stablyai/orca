import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter replacement exit races', () => {
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

  it('captures a replacement exit while the crashed daemon incarnation is still cached', async () => {
    const sessionId = 'replacement-exit-with-stale-incarnation-cache'
    const internals = adapter as unknown as {
      activeSessionIds: Set<string>
      sessionIncarnations: Map<string, string>
      pendingSpawnOperationsBySessionId: Map<
        string,
        Set<{ exitsBySessionId: Map<string, unknown[]> }>
      >
      client: { request: (type: string, payload?: unknown) => Promise<unknown> }
    }
    internals.activeSessionIds.add(sessionId)
    internals.sessionIncarnations.set(sessionId, 'incarnation-from-crashed-daemon')
    const originalRequest = internals.client.request.bind(internals.client)
    vi.spyOn(internals.client, 'request').mockImplementation(
      async (type: string, payload?: unknown) => {
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          lastSubprocess._simulateExit(19)
          await waitFor(() =>
            [...(internals.pendingSpawnOperationsBySessionId.get(sessionId) ?? [])].some(
              (operation) => (operation.exitsBySessionId.get(sessionId)?.length ?? 0) > 0
            )
          )
        }
        return response
      }
    )

    const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result).toMatchObject({
      incarnationId: expect.any(String),
      exitedBeforeSpawnReply: true
    })
    expect(internals.activeSessionIds.has(sessionId)).toBe(false)
    expect(internals.sessionIncarnations.has(sessionId)).toBe(false)
    expect(internals.pendingSpawnOperationsBySessionId.has(sessionId)).toBe(false)
  })
})
