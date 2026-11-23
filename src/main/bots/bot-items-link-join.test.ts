import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

async function itemLink(
  dispatchId: string
): Promise<Extract<BotItemLinkView, { kind: 'dispatch' }>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a worker with no terminal reads the DB and an empty status snapshot only.
  const runtime = {
    getOrchestrationDb: () => db,
    getOrchestrationFleetAgentStatusSnapshot: () => []
  } as unknown as BotWorkRuntime
  const join = new BotItemLinkJoin(runtime, () => ({ pr: {}, issue: {} }))
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
})
