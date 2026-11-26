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
import { recordRemoteStartReceipt } from './remote-start-receipt'
import { openRemoteRunLink, remoteServerPin } from './remote-run-links'
import {
  reportNeverReadyWorkerStart,
  START_BLOCKED_FENCE
} from '../../workers/turn-stops/awaiting-worker-start-report'
import { observeWorker } from '../../workers/turn-stops/worker-presence-report'
import { reportFailedWorkerStart } from '../../workers/turn-stops/failed-worker-start-report'
import { presenceReportId } from '../../workers/turn-stops/worker-turn-stop-report'
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
const KEY = 'start-key'
const COORDINATOR = 'term_coord'
const WORKER_TERMINAL = 'term_worker'
const THREAD_TURN: DispatchCreator = {
  kind: 'terminal',
  handle: COORDINATOR,
  turnSource: 'connector'
}
const ORCA_TURN: DispatchCreator = { kind: 'terminal', handle: COORDINATOR }

/** How a start ends before its worker runs, each reported in production order. */
type Failure = 'start-failed' | 'never-ready' | 'never-ready-in-terminal' | 'start-blocked'
const FAILURES: readonly Failure[] = [
  'start-failed',
  'never-ready',
  'never-ready-in-terminal',
  'start-blocked'
]
/** How this Orca learns which Dispatch its start began: the start's answer, or a receipt lookup after it was lost. */
type Receipt = 'answer' | 'lookup'

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

const sentBy = (address: string) => (message: MessageRow) => message.from_handle === address

/** The coordinator's read of one mail: whether its answer goes to the conversation the start came from. */
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

function openTerminal(db: OrchestrationDb, dispatchId: string, bound: boolean): void {
  db.db
    .prepare(`UPDATE worker_dispatches SET agent_terminal_handle = ? WHERE dispatch_id = ?`)
    .run(WORKER_TERMINAL, dispatchId)
  if (bound) {
    db.db
      .prepare(`UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?`)
      .run(WORKER_TERMINAL, dispatchId)
  }
}

/** The real report each failure's edge sends, on whichever Orca runs the worker: a start that fails
 *  outright has no terminal; a never-ready one in a terminal binds it before reporting; a blocked one
 *  reports from its still-unbound terminal. */
function fail(db: OrchestrationDb, dispatchId: string, failure: Failure): void {
  if (failure === 'start-failed') {
    const failed = db.failWorkerStart(dispatchId, 'worktree_create', 'worktree create timed out')
    reportFailedWorkerStart(db, failed, () => {})
    return
  }
  if (failure !== 'start-blocked') {
    if (failure === 'never-ready-in-terminal') {
      openTerminal(db, dispatchId, true)
    }
    const failed = db.failWorkerStart(dispatchId, 'agent_readiness', 'terminal never ready')
    reportNeverReadyWorkerStart(db, failed, undefined, () => {})
    return
  }
  openTerminal(db, dispatchId, false)
  observeWorker(
    db,
    { kind: 'local', dispatch: db.getDispatchContextById(dispatchId)! },
    {
      presence: 'at-rest',
      fence: START_BLOCKED_FENCE,
      legacyStopKey: START_BLOCKED_FENCE,
      rest: {
        from: WORKER_TERMINAL,
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
    /** worker-start --on as `creator` asks it; nothing reaches the server yet. */
    reserve(creator: DispatchCreator, requestKey = KEY, retryOf?: string) {
      reserveRemotePlacement(home, {
        link,
        taskId: TASK,
        requestKey,
        ...(retryOf ? { retryOf } : { create: { spec: 'work' } }),
        creator: recordedCreatorIdentity(creator)
      })
    },
    neverSent() {
      markRemotePlacementNeverSent(home, TASK, KEY)
    },
    /** The server starts an attempt; nothing comes home yet. */
    start(retryOf?: string) {
      return server.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: TASK,
        ...(retryOf ? { retryOf } : {}),
        startOptions: {}
      }).dispatch.id
    },
    /** This Orca learns which Dispatch its start under `requestKey` began, by `how`. */
    receive(dispatchId: string, how: Receipt, requestKey = KEY) {
      if (how === 'answer') {
        recordRemoteStart(home, {
          conversationId: link.conversation_id,
          taskId: TASK,
          dispatchId,
          requestKey,
          peerRunId
        })
        return
      }
      recordRemoteStartReceipt(home, requestKey, {
        requestId: requestKey,
        state: 'pending',
        method: 'orchestration.workerStart',
        receipt: { accepted: { dispatchId } },
        interpretation: ''
      })
    },
    fail(dispatchId: string, failure: Failure) {
      fail(server, dispatchId, failure)
    },
    /** Orca's never-ready report as a server without the start-outcome id writes it. */
    olderServerNeverReady(dispatchId: string) {
      server.insertMessage({
        id: presenceReportId(dispatchId, 1),
        from: `dispatch:${dispatchId}`,
        to: `run:${peerRunId}`,
        subject: 'Worker never became ready',
        body: 'report',
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify({ dispatchId, stopReason: 'never-ready' }),
        runId: peerRunId,
        senderDispatchId: dispatchId
      })
    },
    /** A running worker's own mail there, dressed as Orca's never-ready report. */
    forgeNeverReady(dispatchId: string) {
      openTerminal(server, dispatchId, true)
      server.insertMessage({
        from: WORKER_TERMINAL,
        to: `run:${peerRunId}`,
        subject: 'Worker never became ready',
        body: 'forged',
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify({ dispatchId, stopReason: 'never-ready' }),
        runId: peerRunId,
        senderDispatchId: dispatchId
      })
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
    judge(pick?: (message: MessageRow) => boolean) {
      return answersThread(home, runId, pick)
    }
  }
}

/** worker-start --on as `creator` asks it; its start fails there and its report comes home. */
function failOnServer(creator: DispatchCreator, failure: Failure, how: Receipt) {
  const run = pairedRun()
  run.reserve(creator)
  const dispatchId = run.start()
  run.receive(dispatchId, how)
  run.fail(dispatchId, failure)
  run.pull()
  return run.judge()
}

describe("a paired server's start outcome reaches its asker as a local one does", () => {
  const cases = FAILURES.flatMap((failure) =>
    (['answer', 'lookup'] as const).flatMap((how) =>
      (['thread', 'orca'] as const).map((asked) => [failure, how, asked] as const)
    )
  )

  it.each(cases)('%s, receipt by %s, asked in %s: remote equals local', (failure, how, asked) => {
    const creator = asked === 'thread' ? THREAD_TURN : ORCA_TURN
    expect(failOnServer(creator, failure, how)).toEqual(failLocally(creator, failure))
  })

  it('answers in the thread for failed and never-ready starts, and keeps a blocked one in Orca', () => {
    expect(FAILURES.map((failure) => failLocally(THREAD_TURN, failure).toThread)).toEqual([
      true,
      true,
      true,
      false
    ])
  })

  it('keeps the outcome in Orca when no receipt of the start reached this Orca', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    run.fail(run.start(), 'never-ready')
    run.pull()
    expect(run.judge().toThread).toBe(false)
  })

  it('takes a receipt that arrives after its report', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.fail(dispatchId, 'never-ready-in-terminal')
    run.pull()
    run.receive(dispatchId, 'lookup')
    expect(run.judge().toThread).toBe(true)
  })

  it("keeps a running worker's report dressed as Orca's in Orca", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.receive(dispatchId, 'answer')
    run.forgeNeverReady(dispatchId)
    run.pull()
    expect(run.judge(sentBy(WORKER_TERMINAL)).toThread).toBe(false)
  })

  it("keeps a server's report without the start-outcome id in Orca", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.receive(dispatchId, 'answer')
    run.olderServerNeverReady(dispatchId)
    run.pull()
    expect(run.judge().toThread).toBe(false)
  })

  it('stays in Orca when someone other than the coordinator asked from a thread', () => {
    const other: DispatchCreator = {
      kind: 'terminal',
      handle: 'term_other',
      turnSource: 'connector'
    }
    expect(failOnServer(other, 'never-ready', 'answer').toThread).toBe(false)
  })
})

describe('the asker a paired-server attempt reports for', () => {
  it.each([
    [ORCA_TURN, THREAD_TURN, false],
    [THREAD_TURN, ORCA_TURN, true]
  ] as const)(
    'keeps the first ask when a later turn retries a sent start',
    (first, retry, toThread) => {
      const run = pairedRun()
      run.reserve(first)
      run.reserve(retry)
      const dispatchId = run.start()
      run.receive(dispatchId, 'lookup')
      run.fail(dispatchId, 'never-ready')
      run.pull()
      expect(run.judge().toThread).toBe(toThread)
    }
  )

  it('takes the retry as the ask when the first send never left this Orca', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    run.neverSent()
    run.reserve(ORCA_TURN)
    const dispatchId = run.start()
    run.receive(dispatchId, 'lookup')
    run.fail(dispatchId, 'never-ready')
    run.pull()
    expect(run.judge().toThread).toBe(false)
  })

  it('names no one for an attempt the server started by itself', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const first = run.start()
    run.receive(first, 'answer')
    run.fail(first, 'never-ready')
    const second = run.start(first)
    run.fail(second, 'never-ready')
    run.pull()
    expect(run.judge(sentBy(`dispatch:${first}`)).toThread).toBe(true)
    expect(run.judge(sentBy(`dispatch:${second}`)).toThread).toBe(false)
  })

  it("keeps a late receipt of an earlier attempt from taking its retry's asker", () => {
    const run = pairedRun()
    run.reserve(ORCA_TURN)
    const first = run.start()
    run.fail(first, 'never-ready')
    run.pull()
    run.reserve(THREAD_TURN, 'retry-key', first)
    run.receive(first, 'answer')
    expect(run.judge(sentBy(`dispatch:${first}`)).toThread).toBe(false)
  })

  it("ignores a lookup's answer for another request", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.receive(dispatchId, 'lookup', 'another-request')
    run.fail(dispatchId, 'never-ready')
    run.pull()
    expect(run.judge().toThread).toBe(false)
  })
})
