import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { BotItemLinkJoin } from './bot-items-link-join'
import type { BotWorkRuntime } from './bot-work-runtime'
import { botItemWorkerStopReason } from '../../shared/bots/bot-item-activity'
import type { BotItemLinkView } from '../../shared/bots/bot-items'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

function failedWorker(error: string): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Polish the strip' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  db.failDispatch(dispatch.id, error, { workerProcessExited: true })
  return dispatch.id
}

function newJoin(): BotItemLinkJoin {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a worker with no terminal reads the DB and an empty status snapshot only.
  const runtime = {
    getOrchestrationDb: () => db,
    getOrchestrationFleetAgentStatusSnapshot: () => []
  } as unknown as BotWorkRuntime
  const join = new BotItemLinkJoin(runtime, () => ({ pr: {}, issue: {} }))
  db.workerStatusListener = (dispatchId, change) =>
    join.workersWritten(dispatchId === null ? [] : [dispatchId], change === 'deleted')
  return join
}

/** A read keeps what it found finished on the turns after it replies. */
async function itemLinkKept(dispatchId: string, join: BotItemLinkJoin) {
  const link = await itemLink(dispatchId, join)
  for (let turn = 0; turn < 2; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  return link
}

async function itemLink(
  dispatchId: string,
  join = newJoin()
): Promise<Extract<BotItemLinkView, { kind: 'dispatch' }>> {
  const reads = await join.readLinkedWorkers([dispatchId])
  const view = join.linkView(
    { itemUid: 'item', kind: 'dispatch', ref: dispatchId, addedEvent: 1 },
    reads.get(dispatchId)
  )
  if (view.kind !== 'dispatch') {
    throw new Error('expected a dispatch link')
  }
  return view
}

describe('item worker links', () => {
  it('show the reason the worker strip shows for a worker that stopped without a report', async () => {
    const link = await itemLink(failedWorker('Agent process exited with code 137'))
    expect(link.state).toBe('failed')
    expect(botItemWorkerStopReason(link)).toBe('Agent process exited with code 137')
  })

  it('keep a settled worker until its lineage is written, then follow its new follow-up', async () => {
    const first = failedWorker('Agent process exited with code 1')
    const join = newJoin()
    expect((await itemLinkKept(first, join)).state).toBe('failed')
    const walks = vi.spyOn(db, 'getDispatchContextById')
    expect((await itemLink(first, join)).state).toBe('failed')
    expect(walks).not.toHaveBeenCalled()
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'Continue the strip' })
    const { dispatch: next } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskId: task.id,
      followUpOf: first,
      startOptions: { agent: 'codex' }
    })
    expect((await itemLink(first, join)).latest).toBe(next.id)
  })

  it('show a long report on a kept read, which keeps the read but not the report', async () => {
    const id = failedWorker('Agent process exited with code 1')
    // Past the kept-report budget, so a kept read rereads it from the Task.
    const body = 'x'.repeat(1_100_000)
    db.updateTaskStatus(
      db.getDispatchContextById(id)!.task_id,
      'failed',
      JSON.stringify({ subject: 'Done', body })
    )
    const join = newJoin()
    await itemLinkKept(id, join)
    const walks = vi.spyOn(db, 'getDispatchContextById')
    expect((await itemLink(id, join)).report).toEqual({ subject: 'Done', body })
    expect(walks).not.toHaveBeenCalled()
  })

  it('show a kept worker’s new report once its Task changes', async () => {
    const id = failedWorker('Agent process exited with code 1')
    const join = newJoin()
    expect((await itemLinkKept(id, join)).report).toBeNull()
    db.updateTaskStatus(
      db.getDispatchContextById(id)!.task_id,
      'failed',
      JSON.stringify({ subject: 'Late report', body: null })
    )
    expect((await itemLink(id, join)).report).toEqual({ subject: 'Late report', body: null })
  })

  it('show a kept worker’s report rewritten to the same length', async () => {
    const id = failedWorker('Agent process exited with code 1')
    const taskId = db.getDispatchContextById(id)!.task_id
    const report = (body: string) => JSON.stringify({ subject: 'Done', body })
    db.updateTaskStatus(taskId, 'failed', report(`a${'x'.repeat(100)}a`))
    const join = newJoin()
    await itemLinkKept(id, join)
    db.updateTaskStatus(taskId, 'failed', report(`a${'y'.repeat(100)}a`))
    expect((await itemLink(id, join)).report?.body).toBe(`a${'y'.repeat(100)}a`)
  })
})
