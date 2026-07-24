import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { OrchestrationDb } from '../../orchestration/db'
import {
  ORCHESTRATION_QUERY_MAX_ROWS,
  ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES,
  ORCHESTRATION_WAIT_TYPE_FILTER_MAX_UTF8_BYTES
} from '../../orchestration/query-retention'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('orchestration RPC query retention', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    db ??= new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    return callWithRuntime(runtime, name, params)
  }

  async function callWithRuntime(
    runtime: OrcaRuntimeService,
    name: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const ctx: RpcContext = { runtime }
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('reports remaining unread messages while successive checks drain the queue', async () => {
    const d = createDb()
    for (let index = 0; index < ORCHESTRATION_QUERY_MAX_ROWS + 1; index += 1) {
      d.insertMessage({ from: 'sender', to: 'worker', subject: `message-${index}` })
    }

    const first = (await call('orchestration.check', { terminal: 'worker' })) as {
      count: number
      truncated?: boolean
      remaining?: number
    }
    expect(first).toMatchObject({
      count: ORCHESTRATION_QUERY_MAX_ROWS,
      truncated: true,
      remaining: 1
    })

    const second = (await call('orchestration.check', { terminal: 'worker' })) as {
      count: number
      truncated?: boolean
    }
    expect(second).toMatchObject({ count: 1 })
    expect(second.truncated).toBeUndefined()
  })

  it('returns truncation instead of waiting forever on an oversized legacy row', async () => {
    const d = createDb()
    sqliteFor(d)
      .prepare(
        `INSERT INTO messages (id, from_handle, to_handle, subject, body)
         VALUES ('msg_oversized', 'sender', 'worker', 'oversized', ?)`
      )
      .run('x'.repeat(ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES + 1))
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(d)
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage')

    const result = await callWithRuntime(runtime, 'orchestration.check', {
      terminal: 'worker',
      wait: true,
      timeoutMs: 60_000
    })

    expect(result).toMatchObject({
      count: 0,
      truncated: true,
      remaining: 1
    })
    expect(waitForMessage).not.toHaveBeenCalled()
  })

  it('rejects oversized waiting type filters before retaining the request', async () => {
    const d = createDb()
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(d)
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage')
    const types = 'status,'.repeat(
      Math.ceil(ORCHESTRATION_WAIT_TYPE_FILTER_MAX_UTF8_BYTES / 'status,'.length) + 1
    )

    await expect(
      callWithRuntime(runtime, 'orchestration.check', {
        terminal: 'worker',
        wait: true,
        types
      })
    ).rejects.toThrow(
      `${ORCHESTRATION_WAIT_TYPE_FILTER_MAX_UTF8_BYTES}-byte orchestration wait limit`
    )
    expect(waitForMessage).not.toHaveBeenCalled()
  })

  it('preserves normal waiting type filters while removing duplicate retention', async () => {
    const d = createDb()
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(d)
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage').mockResolvedValue()

    await expect(
      callWithRuntime(runtime, 'orchestration.check', {
        terminal: 'worker',
        wait: true,
        timeoutMs: 100,
        types: 'status,status,worker_done,escalation,decision_gate'
      })
    ).resolves.toMatchObject({ count: 0, messages: [] })
    expect(waitForMessage).toHaveBeenCalledWith('worker', {
      typeFilter: ['status', 'worker_done', 'escalation', 'decision_gate'],
      timeoutMs: 100,
      signal: undefined
    })
  })

  it('reports exact totals when task and gate lists are capped', async () => {
    const d = createDb()
    const task = d.createTask({ spec: 'gated' })
    for (let index = 0; index < ORCHESTRATION_QUERY_MAX_ROWS + 1; index += 1) {
      d.createTask({ spec: `task-${index}` })
      d.createGate({ taskId: task.id, question: `question-${index}` })
    }

    const tasks = (await call('orchestration.taskList', {})) as {
      count: number
      total?: number
      truncated?: boolean
    }
    expect(tasks).toMatchObject({
      count: ORCHESTRATION_QUERY_MAX_ROWS,
      total: ORCHESTRATION_QUERY_MAX_ROWS + 2,
      truncated: true
    })

    const gates = (await call('orchestration.gateList', {})) as {
      count: number
      total?: number
      truncated?: boolean
    }
    expect(gates).toMatchObject({
      count: ORCHESTRATION_QUERY_MAX_ROWS,
      total: ORCHESTRATION_QUERY_MAX_ROWS + 1,
      truncated: true
    })
  })

  it('reports the exact inbox total when a requested page omits rows', async () => {
    const d = createDb()
    d.insertMessage({ from: 'a', to: 'b', subject: 'one' })
    d.insertMessage({ from: 'a', to: 'b', subject: 'two' })

    await expect(call('orchestration.inbox', { limit: 1 })).resolves.toMatchObject({
      count: 1,
      total: 2,
      truncated: true
    })
  })
})
