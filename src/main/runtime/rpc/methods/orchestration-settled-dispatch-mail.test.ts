import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

describe('orchestration.send to a settled Dispatch mailbox', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, ctx } = h.setup())
  }

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it.each([
    ['completed', (settledDb: OrchestrationDb, id: string) => settledDb.completeDispatch(id)],
    [
      'failed',
      (settledDb: OrchestrationDb, id: string) =>
        settledDb.failDispatch(id, 'worker terminal closed')
    ]
  ])('rejects mail to a %s Dispatch instead of reporting success', async (_status, settle) => {
    setup()
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    settle(db, dispatch.id)

    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'One more thing'
      })
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })

  it('names the Run mailbox that is still reachable', async () => {
    setup()
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.completeDispatch(dispatch.id)

    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'One more thing'
      })
    ).rejects.toThrow(new RegExp(`run:${dispatch.run_id}`))
  })

  it('does not write an undeliverable message row', async () => {
    setup()
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.completeDispatch(dispatch.id)

    await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'One more thing'
    }).catch(() => undefined)

    const stranded = db.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE to_handle = ?')
      .get(`dispatch:${dispatch.id}`) as { count: number }
    expect(stranded.count).toBe(0)
  })

  it('still delivers to an active Dispatch mailbox', async () => {
    setup()
    const task = db.createTask({ spec: 'worker still running' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Pause after this step'
    })) as { message: { to_handle: string } }

    expect(result.message.to_handle).toBe(`dispatch:${dispatch.id}`)
  })
})
