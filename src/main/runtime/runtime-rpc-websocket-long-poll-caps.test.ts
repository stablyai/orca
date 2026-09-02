import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import {
  withCurrentOrchestrationContract,
  waitFor,
  seedSupervisedAskWorkers
} from './runtime-rpc-test-harness'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

describe('OrcaRuntimeRpcServer', () => {
  it('caps WebSocket long-polls and aborts them when the socket closes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: false,
      longPollCap: 1
    })
    const device = server['deviceRegistry'] ?? null
    expect(device).toBeNull()
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const entry = server['deviceRegistry']!.addDevice('runtime-test', 'runtime')
    const ws = new FakeWebSocket()
    server['mobileSocketWiring'] = {
      getConnectionId: () => 'conn-test'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const replies: Record<string, unknown>[] = []

    try {
      const first = server['handleWebSocketMessage'](
        JSON.stringify(
          withCurrentOrchestrationContract({
            id: 'req_wait',
            method: 'orchestration.check',
            deviceToken: entry.token,
            params: { terminal: 'term_wait', wait: true, timeoutMs: 10_000 }
          })
        ),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      await waitFor(() => server['activeLongPolls'] === 1)

      await server['handleWebSocketMessage'](
        JSON.stringify(
          withCurrentOrchestrationContract({
            id: 'req_busy',
            method: 'orchestration.check',
            deviceToken: entry.token,
            params: { terminal: 'term_busy', wait: true, timeoutMs: 10_000 }
          })
        ),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'req_busy',
          ok: false,
          error: expect.objectContaining({ code: 'runtime_busy' })
        })
      )
      expect(server['activeLongPolls']).toBe(1)

      ws.readyState = 3
      ws.emit('close')
      await first

      expect(server['activeLongPolls']).toBe(0)
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_wait', ok: true }))
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('applies the ask sub-cap on the WebSocket path and releases both counters on close', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    seedSupervisedAskWorkers(db, ['term_w0', 'term_w1', 'term_w2'])
    // Why: cap 4 → ask sub-cap 2, so the third ask must be shed while waits keep the other half.
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: false,
      longPollCap: 4
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    // Why: 'runtime' scope, not 'mobile' — orchestration.ask is absent from the mobile allowlist.
    const entry = server['deviceRegistry']!.addDevice('runtime-test', 'runtime')
    const ws = new FakeWebSocket()
    server['mobileSocketWiring'] = {
      getConnectionId: () => 'conn-test'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const replies: Record<string, unknown>[] = []
    const push = (response: string): void => {
      replies.push(JSON.parse(response) as Record<string, unknown>)
    }
    const dispatch = (id: string, method: string, params: unknown): Promise<void> =>
      server['handleWebSocketMessage'](
        JSON.stringify(
          withCurrentOrchestrationContract({ id, method, deviceToken: entry.token, params })
        ),
        push,
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

    try {
      const asks = [0, 1].map((i) =>
        dispatch(`req_ask_${i}`, 'orchestration.ask', {
          from: `term_w${i}`,
          to: 'term_coord',
          question: 'proceed?',
          timeoutMs: 10_000
        })
      )
      // Why: gate on the pre-existing total so a missing sub-cap fails on the shed below, not here.
      await waitFor(() => server['activeLongPolls'] === 2)

      await dispatch('req_ask_overflow', 'orchestration.ask', {
        from: 'term_w2',
        to: 'term_coord',
        question: 'proceed?',
        timeoutMs: 10_000
      })
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'req_ask_overflow',
          ok: false,
          error: expect.objectContaining({
            code: 'runtime_busy',
            message: 'orchestration.ask capacity reached; retry with backoff'
          })
        })
      )
      // Shedding the ask must not burn a slot from the reserved half.
      expect(server['activeLongPolls']).toBe(2)
      expect(server['activeAskLongPolls']).toBe(2)

      const wait = dispatch('req_check_wait', 'orchestration.check', {
        terminal: 'term_other',
        wait: true,
        timeoutMs: 10_000
      })
      await waitFor(() => server['activeLongPolls'] === 3)
      expect(server['activeAskLongPolls']).toBe(2)

      ws.readyState = 3
      ws.emit('close')
      await Promise.all([...asks, wait])

      expect(server['activeLongPolls']).toBe(0)
      expect(server['activeAskLongPolls']).toBe(0)
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_ask_0', ok: true }))
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_check_wait', ok: true }))
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('shares one socket close listener across concurrent WebSocket dispatches', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const entry = server['deviceRegistry']!.addDevice('runtime-test', 'runtime')
    const ws = new FakeWebSocket()
    server['mobileSocketWiring'] = {
      getConnectionId: () => 'conn-test'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    let activeDispatches = 0
    ;(
      server as unknown as {
        dispatcher: {
          dispatchStreaming: (
            request: unknown,
            reply: unknown,
            context: { signal?: AbortSignal }
          ) => Promise<void>
        }
      }
    ).dispatcher = {
      dispatchStreaming: vi.fn(
        async (
          _request: unknown,
          _reply: unknown,
          context: { signal?: AbortSignal }
        ): Promise<void> => {
          activeDispatches += 1
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener(
              'abort',
              () => {
                activeDispatches -= 1
                resolve()
              },
              { once: true }
            )
          })
        }
      )
    } as never

    const pending = Array.from({ length: 12 }, (_entry, index) =>
      server['handleWebSocketMessage'](
        JSON.stringify({
          id: `req_${index}`,
          method: 'status.get',
          deviceToken: entry.token
        }),
        () => {},
        () => {},
        undefined,
        ws as unknown as WebSocket
      )
    )

    await waitFor(() => activeDispatches === 12)
    expect(ws.listenerCount('close')).toBe(1)
    expect(ws.listenerCount('error')).toBe(1)

    ws.readyState = 3
    ws.emit('close')
    await Promise.all(pending)

    expect(activeDispatches).toBe(0)
    expect(ws.listenerCount('close')).toBe(0)
    expect(ws.listenerCount('error')).toBe(0)
  })
})
