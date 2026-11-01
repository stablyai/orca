import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_LOCK_METHODS } from './locks'

describe('orchestration lock and collaboration board RPC methods', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function setup(): { db: OrchestrationDb; ctx: RpcContext } {
    db = new OrchestrationDb(':memory:')
    const ctx = {
      runtime: {
        getOrchestrationDb: () => db!
      }
    } as unknown as RpcContext
    return { db, ctx }
  }

  async function call(name: string, params: Record<string, unknown>, ctx: RpcContext) {
    const method = ORCHESTRATION_LOCK_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : params
    return await (method.handler as (p: unknown, c: RpcContext) => unknown)(parsed, ctx)
  }

  it('acquires a lock, queues a waiting peer, and wakes the peer immediately on lockRelease', async () => {
    const { ctx } = setup()

    const first = (await call(
      'orchestration.lockAcquire',
      {
        resource: 'land:w0m',
        reason: 'Agent A landing',
        from: 'term_agent_a'
      },
      ctx
    )) as { lock: { owner_handle: string; status: string }; position: number }
    expect(first.position).toBe(0)
    expect(first.lock.status).toBe('held')

    const waiterPromise = call(
      'orchestration.lockAcquire',
      {
        resource: 'land:w0m',
        reason: 'Agent B waiting to land',
        wait: true,
        timeoutMs: 5_000,
        from: 'term_agent_b'
      },
      ctx
    ) as Promise<{
      lock: { owner_handle: string; status: string }
      position: number
      waitedMs: number
    }>

    await new Promise((resolve) => setTimeout(resolve, 40))

    const listedWhileWaiting = (await call(
      'orchestration.lockList',
      {
        resource: 'land:w0m'
      },
      ctx
    )) as { count: number; locks: { owner_handle: string; position: number }[] }
    expect(listedWhileWaiting.count).toBe(2)
    expect(listedWhileWaiting.locks.map((l) => [l.owner_handle, l.position])).toEqual([
      ['term_agent_a', 0],
      ['term_agent_b', 1]
    ])

    const releaseResult = (await call(
      'orchestration.lockRelease',
      {
        resource: 'land:w0m',
        from: 'term_agent_a'
      },
      ctx
    )) as { released: boolean; promoted: { owner_handle: string } | null }
    expect(releaseResult.released).toBe(true)
    expect(releaseResult.promoted?.owner_handle).toBe('term_agent_b')

    const second = await waiterPromise
    expect(second.position).toBe(0)
    expect(second.lock.status).toBe('held')
    expect(second.lock.owner_handle).toBe('term_agent_b')
  })

  it('posts, claims, and lists collaboration board entries via RPC', async () => {
    const { db: d, ctx } = setup()

    const posted = (await call(
      'orchestration.boardPost',
      {
        scope: 'w0m',
        kind: 'task',
        title: 'Verify GPG signatures across PRs',
        body: 'Check all 8 upstream PRs',
        from: 'term_coord'
      },
      ctx
    )) as { entry: { id: string; status: string } }
    expect(posted.entry.status).toBe('open')

    const claimed = (await call(
      'orchestration.boardClaim',
      {
        id: posted.entry.id,
        status: 'claimed',
        from: 'term_worker_1'
      },
      ctx
    )) as { entry: { id: string; status: string; assignee_handle: string } }
    expect(claimed.entry.status).toBe('claimed')
    expect(claimed.entry.assignee_handle).toBe('term_worker_1')

    const listed = (await call(
      'orchestration.boardList',
      {
        scope: 'w0m',
        kind: 'task'
      },
      ctx
    )) as { count: number; entries: { id: string; status: string }[] }
    expect(listed.count).toBe(1)
    expect(listed.entries[0]?.id).toBe(posted.entry.id)
    expect(d.listBoardEntries({ scopeKey: 'w0m' })).toHaveLength(1)
  })
})
