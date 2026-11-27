import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { WORKER_AGENT_STARTING_STAGE } from '../../db/worker-dispatch/worker-awaiting-agent-stage'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { observeHeldMailNotice, observeUnconfirmedWorkerStart } from './unconfirmed-worker-start'
import { observeWorker } from './worker-presence-report'

describe('a start whose agent was still starting when Orca restarted', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('is told to its coordinator by the restart pass', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const dispatchId = started.dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_worker',
      paneKey: 'tab_worker:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'worker:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerStartUnknown(dispatchId, WORKER_AGENT_STARTING_STAGE, 'still starting')

    // The new process holds the earlier process's brief, so only this alert says the start is undecided.
    observeUnconfirmedWorkerStart(
      db,
      dispatchId,
      { surface: 'chat' },
      { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }
    )

    expect(readWorkerPresence(db, dispatchId)).toMatchObject({
      presence: 'resting',
      fence: 'start-unconfirmed'
    })
  })
})

describe('a mailbox notice still in a terminal worker prompt after its Enters', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  const deps = () => ({ getDb: () => db, isWaitingForMail: () => false, notify: () => {} })
  const notice = (newestMessageId: string) => ({
    from: 'term_worker',
    newestMessageId,
    screen: '> notice'
  })

  function localWorker() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'work',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    return { kind: 'local' as const, dispatch }
  }

  const reports = () =>
    db.db
      .prepare('SELECT subject FROM messages WHERE from_handle = ?')
      .all('term_worker')
      .map((row) => String(row?.subject))

  it('is told to its coordinator once per notice', () => {
    const target = localWorker()

    observeHeldMailNotice(db, target, notice('msg_1'), deps())
    observeHeldMailNotice(db, target, notice('msg_1'), deps())

    expect(reports()).toEqual(["Worker's mailbox notice may not have been submitted"])
  })

  it('is not told, and leaves the presence working, once a turn was seen', () => {
    const target = localWorker()
    observeWorker(db, target, { presence: 'working' }, deps())

    observeHeldMailNotice(db, target, notice('msg_1'), deps())

    expect(reports()).toEqual([])
    expect(readWorkerPresence(db, target.dispatch.id)?.presence).toBe('working')
  })

  it("is relayed to a paired server worker's Run home", () => {
    db = new OrchestrationDb(':memory:')
    const target = {
      kind: 'remote' as const,
      attachment: { dispatch_id: 'dsp_remote', task_id: 'task_remote' }
    }

    observeHeldMailNotice(db, target, notice('msg_1'), deps())

    const relayed = db.db
      .prepare('SELECT payload FROM federation_relay_items WHERE dispatch_id = ?')
      .all('dsp_remote')
      .map((row) => JSON.parse(String(row?.payload)).subject)
    expect(relayed).toEqual(["Worker's mailbox notice may not have been submitted"])
  })
})
