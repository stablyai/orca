import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import type { DispatchCreator } from '../dispatch-depth'
import type { MessageRow } from '../orchestration-records'
import { recordedCreatorIdentity } from '../dispatch-depth'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { importRemoteOwnedItem } from './remote-owned-import'
import { recordRemoteStart, reserveRemotePlacement } from './remote-placements'
import { markRemotePlacementNeverSent } from './remote-placement-hold'
import { closeRemoteRunLink, openRemoteRunLink, remoteServerPin } from './remote-run-links'
import {
  reportNeverReadyWorkerStart,
  START_BLOCKED_FENCE
} from '../../workers/turn-stops/awaiting-worker-start-report'
import { observeWorker } from '../../workers/turn-stops/worker-presence-report'
import { reportFailedWorkerStart } from '../../workers/turn-stops/failed-worker-start-report'
import { structuredMailSource } from '../../mailbox/structured-mail/structured-mail-source'
import { isConversationReport } from '../../../../external-conversations/external-conversation-turn-opener'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_server',
  name: 'Server',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const TASK = 'task_0123456789ab'
const COORDINATOR = 'term_coord'
const THREAD_TURN: DispatchCreator = {
  kind: 'terminal',
  handle: COORDINATOR,
  turnSource: 'connector'
}
const ORCA_TURN: DispatchCreator = { kind: 'terminal', handle: COORDINATOR }

type Failure = 'start-failed' | 'never-ready' | 'never-ready-in-terminal' | 'start-blocked'
const open: OrchestrationDb[] = []
afterEach(() => {
  for (const db of open.splice(0)) {
    db.close()
  }
})

function newDb(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  open.push(db)
  return db
}

/** The coordinator's read of the mail: whether its answer goes to the conversation the start came from. */
function answersThread(
  db: OrchestrationDb,
  runId: string,
  pick: (message: MessageRow) => boolean = () => true
) {
  const mail = db.getAllMessagesForHandle(`run:${runId}`).filter(pick)
  expect(mail).toHaveLength(1)
  const message = mail[0]!
  const from = structuredMailSource({
    db,
    mailboxHandle: `run:${runId}`,
    dispatchId: null,
    batch: [message],
    senderSnapshot: () => ({ name: 'worker', agent: null })
  })
  return {
    subject: message.subject,
    type: message.type,
    toThread: isConversationReport({ kind: 'message', role: 'user', blocks: [], from })
  }
}

/** The real report each failure's edge sends, on whichever Orca runs the worker, in production order:
 *  a start fails or blocks before its terminal is bound as the Dispatch's assignee. */
function fail(db: OrchestrationDb, dispatchId: string, failure: Failure): void {
  if (failure === 'start-failed') {
    const failed = db.failWorkerStart(dispatchId, 'worktree_create', 'worktree create timed out')
    reportFailedWorkerStart(db, failed, () => {})
    return
  }
  if (failure !== 'never-ready') {
    // Its terminal opened and holds the start, unbound.
    db.db
      .prepare(
        `UPDATE worker_dispatches SET agent_terminal_handle = 'term_worker' WHERE dispatch_id = ?`
      )
      .run(dispatchId)
  }
  if (failure === 'never-ready' || failure === 'never-ready-in-terminal') {
    const failed = db.failWorkerStart(dispatchId, 'agent_readiness', 'terminal never ready')
    reportNeverReadyWorkerStart(db, failed, undefined, () => {})
    return
  }
  observeWorker(
    db,
    { kind: 'local', dispatch: db.getDispatchContextById(dispatchId)! },
    {
      presence: 'at-rest',
      fence: START_BLOCKED_FENCE,
      legacyStopKey: START_BLOCKED_FENCE,
      rest: {
        from: 'term_worker',
        reason: 'start-blocked',
        blockedStart: { screen: 'a sign-in screen', readyBy: 1_700_000_000_000 },
        lastOutput: 'Sign in to continue'
      }
    },
    { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }
  )
}

function failLocally(creator: DispatchCreator, failure: Failure) {
  const db = newDb()
  const run = db.createRun({
    objective: 'o',
    coordinatorHandle: COORDINATOR,
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator,
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  fail(db, dispatch.id, failure)
  return answersThread(db, run.id)
}

/** This Orca's Run placed on a paired server, and that server, with the real start records and queue. */
function pairedRun() {
  const home = newDb()
  const server = newDb()
  const runId = home.createRun({
    objective: 'o',
    coordinatorHandle: COORDINATOR,
    coordinatorPaneKey: null
  }).id
  const link = openRemoteRunLink(home, runId, SERVER)
  const peerRunId = server.admitPeerRun({
    peerFingerprint: 'fp_home',
    peerRun: { runId, conversationId: link.conversation_id, label: 'home' }
  }).run_id
  server.createTask({ id: TASK, spec: 'work', runId: peerRunId })
  return {
    home,
    runId,
    /** worker-start --on as `creator` asks it; nothing goes to the server yet. */
    reserve(creator: DispatchCreator, requestKey: string, retryOf?: string) {
      reserveRemotePlacement(home, {
        link,
        taskId: TASK,
        requestKey,
        ...(retryOf ? { retryOf } : { create: { spec: 'work' } }),
        creator: recordedCreatorIdentity(creator)
      })
    },
    neverSent(requestKey: string) {
      markRemotePlacementNeverSent(home, TASK, requestKey)
    },
    /** The server starts an attempt and fails it; `answered` records its start answer here. */
    startAndFail(failure: Failure, options: { retryOf?: string; answered?: string } = {}) {
      const { dispatch } = server.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: TASK,
        ...(options.retryOf ? { retryOf: options.retryOf } : {}),
        startOptions: {}
      })
      if (options.answered) {
        recordRemoteStart(home, {
          conversationId: link.conversation_id,
          taskId: TASK,
          dispatchId: dispatch.id,
          requestKey: options.answered,
          peerRunId
        })
      }
      fail(server, dispatch.id, failure)
      return dispatch.id
    },
    /** Imports everything the server queued home, as the pull loop does. */
    pull() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly these columns.
      const items = server.db
        .prepare(
          `SELECT sequence, message_id AS messageId, kind, payload FROM federation_relay_items
           WHERE dispatch_id = ? AND direction = 'to_home' ORDER BY sequence`
        )
        .all(link.conversation_id) as {
        sequence: number
        messageId: string
        kind: string
        payload: string
      }[]
      for (const item of items) {
        importRemoteOwnedItem(home, remoteServerPin(SERVER), {
          ...item,
          conversationId: link.conversation_id
        })
      }
    },
    close() {
      closeRemoteRunLink(home, link.conversation_id, 'The pairing was removed.')
    },
    judge(pick?: (message: MessageRow) => boolean) {
      return answersThread(home, runId, pick)
    }
  }
}

const sentBy = (dispatchId: string) => (message: MessageRow) =>
  message.from_handle === `dispatch:${dispatchId}`

/** worker-start --on: the server answers 'starting', or its answer is lost, then the start fails there
 *  and its queue carries the report home. */
function failOnServer(creator: DispatchCreator, failure: Failure, answer: 'starting' | 'lost') {
  const run = pairedRun()
  run.reserve(creator, 'start-key')
  run.startAndFail(failure, answer === 'starting' ? { answered: 'start-key' } : {})
  run.pull()
  return run.judge()
}

describe("a paired server's failed or stalled start reaches its coordinator as a local one does", () => {
  const failures = [
    'start-failed',
    'never-ready',
    'never-ready-in-terminal',
    'start-blocked'
  ] as const
  const cases = failures.flatMap((failure) =>
    (['starting', 'lost'] as const).map((answer) => [failure, answer] as const)
  )

  it.each(cases)('%s after a %s answer, asked from a thread', (failure, answer) => {
    expect(failOnServer(THREAD_TURN, failure, answer)).toEqual(failLocally(THREAD_TURN, failure))
  })

  it.each(cases)('%s after a %s answer, asked in Orca, stays in Orca', (failure, answer) => {
    const local = failLocally(ORCA_TURN, failure)
    expect(local.toThread).toBe(false)
    expect(failOnServer(ORCA_TURN, failure, answer)).toEqual(local)
  })

  it('answers in the thread for the results Orca reports as the Dispatch', () => {
    for (const failure of ['start-failed', 'never-ready'] as const) {
      expect(failLocally(THREAD_TURN, failure).toThread).toBe(true)
      expect(failOnServer(THREAD_TURN, failure, 'lost').toThread).toBe(true)
    }
  })

  it('stays in Orca when someone other than the coordinator started it from a thread', () => {
    const other: DispatchCreator = {
      kind: 'terminal',
      handle: 'term_other',
      turnSource: 'connector'
    }
    expect(failOnServer(other, 'never-ready', 'starting').toThread).toBe(false)
  })
})

describe('the asker an attempt reports for', () => {
  it.each([
    [ORCA_TURN, THREAD_TURN, false],
    [THREAD_TURN, ORCA_TURN, true]
  ] as const)(
    'keeps the first ask when a later turn retries a sent start',
    (first, retry, toThread) => {
      const run = pairedRun()
      run.reserve(first, 'start-key')
      run.reserve(retry, 'start-key')
      run.startAndFail('never-ready')
      run.pull()
      expect(run.judge().toThread).toBe(toThread)
    }
  )

  it('takes the retry as the ask when the first send never left this Orca', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN, 'start-key')
    run.neverSent('start-key')
    run.reserve(ORCA_TURN, 'start-key')
    run.startAndFail('never-ready')
    run.pull()
    expect(run.judge().toThread).toBe(false)
  })

  it('names no one for an attempt the server started by itself', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN, 'start-key')
    const first = run.startAndFail('never-ready', { answered: 'start-key' })
    const second = run.startAndFail('never-ready', { retryOf: first })
    run.pull()
    expect(run.judge(sentBy(first)).toThread).toBe(true)
    expect(run.judge(sentBy(second)).toThread).toBe(false)
  })

  it("names no one for a reservation whose asker a build without this record didn't write", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN, 'start-key')
    const first = run.startAndFail('never-ready', { answered: 'start-key' })
    run.pull()
    // That build's retry rewrites the reservation under its own key and leaves the asker columns.
    run.home.db
      .prepare(
        `UPDATE remote_placements SET state = 'reserved', request_key = 'old-build-key',
           dispatch_id = ? WHERE task_id = ?`
      )
      .run(first, TASK)
    run.home.db.prepare(`UPDATE tasks SET status = 'dispatched' WHERE id = ?`).run(TASK)
    const retry = run.startAndFail('never-ready', { retryOf: first })
    run.pull()
    expect(run.judge(sentBy(retry)).toThread).toBe(false)
  })

  it("keeps a retry's lost-pairing notice in Orca, not as the attempt it retries", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN, 'start-key')
    const first = run.startAndFail('never-ready', { answered: 'start-key' })
    run.pull()
    run.reserve(ORCA_TURN, 'retry-key', first)
    run.close()
    expect(run.judge((message) => message.subject.startsWith('Worker unreachable')).toThread).toBe(
      false
    )
  })
})
