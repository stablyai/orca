import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import type { DispatchCreator } from '../dispatch-depth'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import type { MessageRow } from '../orchestration-records'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { importRemoteOwnedItem } from './remote-owned-import'
import { recordRemoteStart, reserveRemotePlacement } from './remote-placements'
import { markRemotePlacementNeverSent } from './remote-placement-hold'
import { openRemoteRunLink, remoteServerPin } from './remote-run-links'
import { getRemoteDispatch } from './remote-dispatch-records'
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
const BOT_SESSION = '7d3c1e52-9a4b-4f0e-8c21-5b6a7f8e9d01'
if (!isOrcaSessionId(BOT_SESSION)) {
  throw new Error('fixture needs an Orca session id')
}
/** A bot's chat: a session coordinator, woken by its thread. */
const BOT_THREAD_TURN: DispatchCreator = {
  kind: 'session',
  orcaSessionId: BOT_SESSION,
  turnSource: 'connector'
}

/** A Run coordinated by `creator`'s terminal or, for a session creator, by that session. */
function createRun(db: OrchestrationDb, creator?: DispatchCreator) {
  return db.createRun({
    objective: 'o',
    coordinatorHandle: creator?.kind === 'session' ? null : COORDINATOR,
    coordinatorPaneKey: null,
    ...(creator?.kind === 'session' ? { coordinatorOrcaSessionId: creator.orcaSessionId } : {})
  })
}

/** How a start ends before its worker runs, each reported in production order. */
type Failure =
  | 'start-failed'
  | 'never-ready'
  | 'never-ready-in-terminal'
  | 'never-ready-unbound'
  | 'start-blocked'
const FAILURES: readonly Failure[] = [
  'start-failed',
  'never-ready',
  'never-ready-in-terminal',
  'never-ready-unbound',
  'start-blocked'
]

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

/** Where the worker's terminal runs, relative to the Orca that starts it. */
type Host = 'this-computer' | 'ssh'

/** The real report each failure's edge sends, on whichever Orca runs the worker: a start that fails
 *  outright has no terminal; a never-ready one in a terminal binds it before reporting; a blocked one
 *  reports from its still-unbound terminal. */
function fail(db: OrchestrationDb, dispatchId: string, failure: Failure, host: Host): void {
  if (host === 'ssh') {
    // Its workspace is one this computer reaches over SSH, so its terminal runs there.
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'ssh-target' }), dispatchId)
  }
  if (failure === 'start-failed') {
    const failed = db.failWorkerStart(dispatchId, 'worktree_create', 'worktree create timed out')
    reportFailedWorkerStart(db, failed, () => {})
    return
  }
  if (failure !== 'start-blocked') {
    // A restart that cuts a start before it bound its terminal reports never-ready from it unbound.
    if (failure !== 'never-ready') {
      openTerminal(db, dispatchId, failure === 'never-ready-in-terminal')
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

function failLocally(creator: DispatchCreator, failure: Failure, host: Host = 'this-computer') {
  const db = newDb()
  const run = createRun(db, creator)
  const task = db.createTask({ runId: run.id, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator,
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  fail(db, dispatch.id, failure, host)
  return answersThread(db, run.id)
}

/** This Orca's Run placed on a paired server, and that server, with the real start records and queue. */
function pairedRun(coordinator?: DispatchCreator) {
  const home = newDb()
  const server = newDb()
  const runId = createRun(home, coordinator).id
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
        creator
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
    /** The server's answer to this Orca's start under `requestKey` names the Dispatch it began. */
    receive(dispatchId: string, requestKey = KEY) {
      recordRemoteStart(home, {
        conversationId: link.conversation_id,
        taskId: TASK,
        dispatchId,
        requestKey,
        peerRunId
      })
    },
    fail(dispatchId: string, failure: Failure, host: Host = 'this-computer') {
      fail(server, dispatchId, failure, host)
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
    /** Who this Orca's record of the attempt says started it. */
    creatorOf(dispatchId: string) {
      const record = getRemoteDispatch(home, dispatchId)
      return [record?.creator_handle, record?.creator_turn_source]
    },
    judge(pick?: (message: MessageRow) => boolean) {
      return answersThread(home, runId, pick)
    }
  }
}

/** worker-start --on as `creator` asks it; its start fails there and its report comes home. */
function failOnServer(creator: DispatchCreator, failure: Failure, host: Host = 'this-computer') {
  const run = pairedRun(creator)
  run.reserve(creator)
  const dispatchId = run.start()
  run.receive(dispatchId)
  run.fail(dispatchId, failure, host)
  run.pull()
  return run.judge()
}

describe("a paired server's start outcome reaches its asker as a local one does", () => {
  const cases = FAILURES.flatMap((failure) =>
    (['this-computer', 'ssh'] as const).flatMap((host) =>
      (['thread', 'orca', 'bot-thread'] as const).map((asked) => [failure, host, asked] as const)
    )
  )

  it.each(cases)('%s on %s, asked in %s: remote equals local', (failure, host, asked) => {
    const creator = { thread: THREAD_TURN, orca: ORCA_TURN, 'bot-thread': BOT_THREAD_TURN }[asked]
    expect(failOnServer(creator, failure, host)).toEqual(failLocally(creator, failure, host))
  })

  it("keeps an SSH worker's start outcome in Orca, as local does", () => {
    for (const failure of ['start-failed', 'never-ready-in-terminal'] as const) {
      expect(failLocally(THREAD_TURN, failure, 'ssh').toThread).toBe(false)
    }
  })

  it('answers in the thread for failed and never-ready starts, and keeps an unbound one in Orca', () => {
    expect(FAILURES.map((failure) => failLocally(THREAD_TURN, failure).toThread)).toEqual([
      true,
      true,
      true,
      false,
      false
    ])
  })

  it("keeps the outcome in Orca when the start's answer never reached this Orca", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.fail(dispatchId, 'never-ready')
    run.pull()
    // The queue's adoption copied the placement's creator; only the start's answer proves the ask.
    expect(run.creatorOf(dispatchId)).toEqual([COORDINATOR, 'connector'])
    expect(run.judge().toThread).toBe(false)
  })

  it('takes a start answer that arrives after its report', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.fail(dispatchId, 'never-ready-in-terminal')
    run.pull()
    run.receive(dispatchId)
    expect(run.judge().toThread).toBe(true)
  })

  it("keeps a running worker's report dressed as Orca's in Orca", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.receive(dispatchId)
    run.forgeNeverReady(dispatchId)
    run.pull()
    expect(run.judge(sentBy(WORKER_TERMINAL)).toThread).toBe(false)
  })

  it("keeps a server's report without the start-outcome id in Orca", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const dispatchId = run.start()
    run.receive(dispatchId)
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
    expect(failOnServer(other, 'never-ready').toThread).toBe(false)
  })
})

describe('the asker a paired-server attempt reports for', () => {
  // A retry by someone else may be what started the work the server answers for: it proves no one.
  it.each([
    [THREAD_TURN, THREAD_TURN, true],
    [ORCA_TURN, THREAD_TURN, false],
    [THREAD_TURN, ORCA_TURN, false]
  ] as const)(
    'proves the asker of a sent start only when the same turn source retries it',
    (first, retry, toThread) => {
      const run = pairedRun()
      run.reserve(first)
      run.reserve(retry)
      const dispatchId = run.start()
      run.receive(dispatchId)
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
    run.receive(dispatchId)
    run.fail(dispatchId, 'never-ready')
    run.pull()
    expect(run.judge().toThread).toBe(false)
  })

  it("names no one for work a re-send starts after the server forgot the key's answer", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const first = run.start()
    run.receive(first)
    run.fail(first, 'never-ready')
    // The server evicted the key's receipt, so the same key starts fresh work there.
    run.reserve(ORCA_TURN)
    const second = run.start(first)
    run.receive(second)
    run.receive(first)
    run.fail(second, 'never-ready')
    run.pull()
    expect(run.judge(sentBy(`dispatch:${first}`)).toThread).toBe(true)
    expect(run.judge(sentBy(`dispatch:${second}`)).toThread).toBe(false)
    // A new start of the Task is an ask of its own again.
    run.reserve(THREAD_TURN, 'retry-key', second)
    const third = run.start(second)
    run.receive(third, 'retry-key')
    run.fail(third, 'never-ready')
    run.pull()
    expect(run.judge(sentBy(`dispatch:${third}`)).toThread).toBe(true)
  })

  it("proves no asker that the attempt's record does not name", () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    run.neverSent()
    const dispatchId = run.start()
    run.fail(dispatchId, 'never-ready')
    // The queue's adoption names the first asker; a later first-send retry names another.
    run.pull()
    run.reserve(ORCA_TURN)
    run.receive(dispatchId)
    expect(run.creatorOf(dispatchId)).toEqual([COORDINATOR, 'connector'])
    expect(run.judge().toThread).toBe(false)
  })

  it("keeps a proven attempt's asker when a retry's ask arrives later", () => {
    const run = pairedRun()
    run.reserve({ kind: 'system' })
    const first = run.start()
    run.receive(first)
    run.fail(first, 'never-ready')
    run.pull()
    run.reserve(THREAD_TURN, 'retry-key', first)
    // A late copy of the first start's answer.
    run.receive(first)
    expect(run.judge(sentBy(`dispatch:${first}`)).toThread).toBe(false)
  })

  it('names no one for an attempt the server started by itself', () => {
    const run = pairedRun()
    run.reserve(THREAD_TURN)
    const first = run.start()
    run.receive(first)
    run.fail(first, 'never-ready')
    const second = run.start(first)
    run.fail(second, 'never-ready')
    run.pull()
    expect(run.creatorOf(second)).toEqual([COORDINATOR, 'connector'])
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
    run.receive(first)
    expect(run.judge(sentBy(`dispatch:${first}`)).toThread).toBe(false)
  })
})
