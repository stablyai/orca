import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession, sleep } from './runtime-rpc-test-harness'

// `dispatch --inject` into a chat waits for its agent to accept the turn, which can outlast the
// socket's idle timer; keepalives hold the connection open as they do for worker-start. A terminal
// inject doesn't wait, so it stays a short RPC.
describe('orchestration.dispatch --inject as a long poll', () => {
  it('is a keepalive-backed wait only when it injects into a chat', () => {
    const dispatch = (params: Record<string, unknown>) =>
      classifyRuntimeLongPoll({
        id: 'req_dispatch',
        authToken: 'token',
        method: 'orchestration.dispatch',
        params
      })
    expect(dispatch({ task: 'task_1', to: 'orca_session_id:x', inject: true })).toBe('mutation')
    expect(dispatch({ task: 'task_1', to: 'orca_session_id:x' })).toBeNull()
    // A terminal inject writes and returns; it keeps a short-RPC slot.
    expect(dispatch({ task: 'task_1', to: 'term_worker', inject: true })).toBeNull()
  })

  it('emits keepalives while an injected dispatch blocks', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs: 30 })
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request) => {
      await sleep(120)
      return {
        id: request.id,
        ok: true,
        result: { dispatch: { id: 'ctx_1' }, injected: true },
        _meta: { runtimeId: runtime.getRuntimeId() }
      }
    })
    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const session = openFramedSession(metadata!.transports[0]!.endpoint, {
        id: 'req_dispatch',
        authToken: metadata!.authToken,
        method: 'orchestration.dispatch',
        params: { task: 'task_1', to: 'orca_session_id:x', inject: true }
      })
      await session.done

      expect(
        session.frames.filter((frame) => frame._keepalive === true).length
      ).toBeGreaterThanOrEqual(2)
      expect(session.frames.filter((frame) => frame.ok !== undefined)).toEqual([
        expect.objectContaining({ id: 'req_dispatch', ok: true })
      ])
    } finally {
      await server.stop()
    }
  })
})
