import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import type { DispatchCreator } from '../dispatch-depth'
import { recordedCreatorIdentity } from '../dispatch-depth'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { importRemoteOwnedItem } from './remote-owned-import'
import { recordRemoteStart, reserveRemotePlacement } from './remote-placements'
import { openRemoteRunLink, remoteServerPin } from './remote-run-links'
import { recordPlacementCreator } from './remote-placement-hold'
import {
  reportNeverReadyWorkerStart,
  START_BLOCKED_FENCE
} from '../../workers/turn-stops/awaiting-worker-start-report'
import { observeWorker } from '../../workers/turn-stops/worker-presence-report'
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

type Failure = 'never-ready' | 'start-blocked'
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
function answersThread(db: OrchestrationDb, runId: string) {
  const mail = db.getAllMessagesForHandle(`run:${runId}`)
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

/** The real report each failure's edge sends, on whichever Orca runs the worker. */
function fail(db: OrchestrationDb, dispatchId: string, failure: Failure): void {
  if (failure === 'never-ready') {
    const failed = db.failWorkerStart(dispatchId, 'agent_readiness', 'terminal never ready')
    reportNeverReadyWorkerStart(db, failed, undefined, () => {})
    return
  }
  // A start blocks once its terminal is bound, which makes that terminal the Dispatch's assignee.
  db.db
    .prepare(`UPDATE dispatch_contexts SET assignee_handle = 'term_worker' WHERE id = ?`)
    .run(dispatchId)
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

/** worker-start --on: the server answers 'starting', or its answer is lost, then the start fails there
 *  and its queue carries the report home. */
function failOnServer(creator: DispatchCreator, failure: Failure, answer: 'starting' | 'lost') {
  const home = newDb()
  const server = newDb()
  const homeRunId = home.createRun({
    objective: 'o',
    coordinatorHandle: COORDINATOR,
    coordinatorPaneKey: null
  }).id
  const link = openRemoteRunLink(home, homeRunId, SERVER)
  reserveRemotePlacement(home, {
    link,
    taskId: TASK,
    requestKey: 'start-key',
    create: { spec: 'work' }
  })
  recordPlacementCreator(home, TASK, recordedCreatorIdentity(creator))
  const peerRunId = server.admitPeerRun({
    peerFingerprint: 'fp_home',
    peerRun: { runId: homeRunId, conversationId: link.conversation_id, label: 'home' }
  }).run_id
  server.createTask({ id: TASK, spec: 'work', runId: peerRunId })
  const { dispatch } = server.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: TASK,
    startOptions: {}
  })
  if (answer === 'starting') {
    recordRemoteStart(home, {
      conversationId: link.conversation_id,
      taskId: TASK,
      dispatchId: dispatch.id,
      requestKey: 'start-key',
      peerRunId
    })
  }
  fail(server, dispatch.id, failure)
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
  return answersThread(home, homeRunId)
}

describe("a paired server's failed or stalled start reaches its coordinator as a local one does", () => {
  const cases = (['never-ready', 'start-blocked'] as const).flatMap((failure) =>
    (['starting', 'lost'] as const).map((answer) => [failure, answer] as const)
  )

  it.each(cases)('%s after a %s answer, asked from a thread', (failure, answer) => {
    const local = failLocally(THREAD_TURN, failure)
    expect(local.toThread).toBe(true)
    expect(failOnServer(THREAD_TURN, failure, answer)).toEqual(local)
  })

  it.each(cases)('%s after a %s answer, asked in Orca, stays in Orca', (failure, answer) => {
    const local = failLocally(ORCA_TURN, failure)
    expect(local.toThread).toBe(false)
    expect(failOnServer(ORCA_TURN, failure, answer)).toEqual(local)
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
