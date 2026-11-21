// Random orderings of agent-question events against the real database, writers and reconciler.
// The world (who runs, who is paused, which workers run, which handovers are in flight) is a model
// the reconciler's reads report from; the checks compare its decisions with that model only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { noteQuestionEdge, type QuestionEdge } from '../../db/messages/question-edges'
import type { MailTaker } from '../../db/messages/mail-taker'
import { linkWorkerToQuestion } from '../../../rpc/methods/orchestration/worker/start/worker-question-link'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { QuestionReconciler } from './question-reconciler'
import type { QuestionPartyReads } from './question-party-facts'
import {
  RECEIVERS,
  randomOp,
  rng,
  shrink,
  type HandoverEnd,
  type Op
} from './question-reconcile-invariant.test-fixture'

type PartyState = 'resting' | 'running' | 'prompt' | 'closed' | 'paused' | 'deleted'
type Question = { id: string; to: number; taker: string | null; answered: boolean }
type Worker = {
  dispatchId: string
  question: string
  state: 'starting' | 'running' | 'resting' | 'ended'
}
type Mail = { id: string; mailbox: string }
type Violation = { kind: string; detail: string }

/** A mutation run (AQ_SKIP_EDGE): one edge the reconciler never hears, to prove the test needs it. */
const SKIP = process.env.AQ_SKIP_EDGE ?? ''
const EDGE_KINDS: Record<string, QuestionEdge['kind'] | undefined> = {
  E4: 'take',
  E5: 'dispatch',
  E6: 'mailbox',
  E12: 'mail'
}
const STOPPED: readonly PartyState[] = ['closed', 'paused', 'deleted']
/** The receivers' chats, by Orca session id. */
const SESSIONS = Array.from(
  { length: RECEIVERS },
  (_, i) => `00000000-0000-4000-8000-00000000000${i}`
)
const session = (index: number): string => SESSIONS[index]!

class World {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-question-invariant-'))
  file = path.join(this.dir, 'orchestration.db')
  db = new OrchestrationDb(this.file)
  state: PartyState[] = Array.from({ length: RECEIVERS }, (): PartyState => 'resting')
  runId: string
  questions: Question[] = []
  workers: Worker[] = []
  /** Mail a delivery pass would select now. */
  pending: Mail[] = []
  /** Mail a pass is handing over now (in memory: gone with the process). */
  handing: Mail[] = []
  told = new Map<string, number>()
  violations: Violation[] = []
  edgesLive = true
  reconciler!: QuestionReconciler
  stop: () => void = () => undefined
  seq = 0

  constructor() {
    this.runId = this.db.createRun({
      objective: 'invariant',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    }).id
    this.startReconciler()
  }

  mailbox(index: number): string {
    return `orca_session_id:${session(index)}`
  }
  receiverOf(chat: string): number | null {
    const index = SESSIONS.indexOf(chat)
    return index === -1 ? null : index
  }
  workerOf(session: string): Worker | undefined {
    return this.workers.find((worker) => `W-${worker.dispatchId}` === session)
  }
  receiving(session: string): boolean {
    const receiver = this.receiverOf(session)
    if (receiver !== null) {
      return !STOPPED.includes(this.state[receiver]!)
    }
    const state = this.workerOf(session)?.state
    return state === 'running' || state === 'resting'
  }
  running(session: string): boolean {
    const receiver = this.receiverOf(session)
    return receiver !== null
      ? this.state[receiver] === 'running'
      : this.workerOf(session)?.state === 'running'
  }

  reads: QuestionPartyReads = {
    liveSession: (root) => root,
    chatRunning: async (session) => this.running(session),
    chatReceiving: (mailbox) => {
      const session = mailbox.startsWith('dispatch:')
        ? `W-${mailbox.slice('dispatch:'.length)}`
        : mailbox.slice('orca_session_id:'.length)
      return this.receiving(session) ? session : null
    },
    chatHandingOver: (mailbox) => this.handing.some((mail) => mail.mailbox === mailbox),
    terminal: () => null,
    terminalHandingOver: () => false
  }

  startReconciler(): void {
    const write = (messageId: string) => {
      this.db.recordBotRequestOutcome(messageId, 'unanswered')
      this.told.set(messageId, (this.told.get(messageId) ?? 0) + 1)
      const question = this.questions.find((q) => q.id === messageId)
      const why = question?.taker ? this.busy(question.taker, question.id) : null
      if (why) {
        this.violations.push({ kind: 'early', detail: `${messageId} told while ${why}` })
      }
      return 'told' as const
    }
    this.reconciler = new QuestionReconciler(this.db, {
      reads: this.reads,
      notices: async () => (notice) => write(notice.messageId),
      sessionParty: (session) => `session:${session}`,
      terminalParty: () => null
    })
    const skipped = EDGE_KINDS[SKIP]
    if (skipped) {
      // A mutation run: the reconciler never hears this kind of edge.
      const onEdge = this.reconciler['onEdge'].bind(this.reconciler)
      this.reconciler['onEdge'] = (edge) => (edge.kind === skipped ? undefined : onEdge(edge))
    }
    this.stop = SKIP === 'E9' ? this.listenOnly() : this.reconciler.start()
  }

  /** For a mutation run: the edges without the decision at open. */
  listenOnly(): () => void {
    const decideAll = this.reconciler.decideAll.bind(this.reconciler)
    this.reconciler.decideAll = () => undefined
    const stop = this.reconciler.start()
    this.reconciler.decideAll = decideAll
    return stop
  }

  // ---- ground truth, from the model only ----
  wakePending(session: string): boolean {
    const mailboxes =
      this.receiverOf(session) !== null
        ? [this.mailbox(this.receiverOf(session)!)]
        : [`dispatch:${session.slice('W-'.length)}`]
    return (
      this.receiving(session) &&
      [...this.pending, ...this.handing].some((mail) => mailboxes.includes(mail.mailbox))
    )
  }
  busy(taker: string, question: string): string | null {
    if (!taker.startsWith('session:')) {
      return null
    }
    const session = taker.slice('session:'.length)
    if (this.running(session) || this.wakePending(session)) {
      return `${taker} is running or about to`
    }
    for (const worker of this.workers) {
      if (worker.question !== question || worker.state === 'ended') {
        continue
      }
      const party = `W-${worker.dispatchId}`
      if (worker.state === 'starting' || this.running(party) || this.wakePending(party)) {
        return `linked ${worker.dispatchId} works`
      }
    }
    return null
  }

  // ---- edges a live runtime fires ----
  observe(session: string): void {
    if (this.edgesLive && SKIP !== 'E1') {
      this.reconciler.chatObserved(session, this.running(session))
    }
  }
  setState(index: number, next: PartyState): void {
    this.state[index] = next
    this.observe(session(index))
  }

  take(ids: string[], taker: MailTaker, read: boolean): void {
    if (ids.length === 0) {
      return
    }
    const key = taker.kind === 'session' ? `session:${taker.sessionId}` : `${taker.kind}`
    if (read) {
      this.db.markAsRead(ids, taker)
    } else {
      // A card queued behind a person: taken, still unread.
      const mailboxes = new Set(
        this.pending.filter((m) => ids.includes(m.id)).map((m) => m.mailbox)
      )
      for (const mailbox of mailboxes) {
        this.db.markAsDelivered(ids, mailbox)
      }
      for (const id of ids) {
        this.db.retireStructuredMailSend(this.reserve(id), { read: false, taker })
      }
    }
    for (const question of this.questions) {
      if (ids.includes(question.id) && question.taker === null) {
        question.taker = taker.kind === 'dropped' ? `dropped:${taker.why}` : key
      }
    }
    this.pending = this.pending.filter((mail) => !ids.includes(mail.id))
  }

  reserve(id: string): Parameters<OrchestrationDb['retireStructuredMailSend']>[0] {
    const message = this.db.getMessageById(id)!
    const held = this.db.getStructuredMailSend(message.to_handle, id)
    if (held) {
      return held
    }
    const row = {
      mailbox_handle: message.to_handle,
      message_id: id,
      session_id: message.to_handle.replace(/^orca_session_id:|^dispatch:/, ''),
      operation_id: `op-${this.seq++}`,
      minted_at_ms: Date.now()
    }
    this.db.reserveStructuredMailSend(row)
    return row
  }

  pendingFor(index: number): string[] {
    return this.pending.filter((m) => m.mailbox === this.mailbox(index)).map((m) => m.id)
  }

  /** The `pick`th receiver with mail in `mail`, so a delivery op always finds something to do. */
  withMail(mail: readonly Mail[], pick: number): number {
    const waiting = [0, 1, 2].filter((i) => mail.some((m) => m.mailbox === this.mailbox(i)))
    return waiting[pick % Math.max(waiting.length, 1)] ?? pick
  }

  liveWorker(index: number): Worker | undefined {
    const live = this.workers.filter((worker) => worker.state !== 'ended')
    return live[index % Math.max(live.length, 1)]
  }

  holderOf(by: number): { index: number; question: Question } | null {
    const holders = [0, 1].filter(
      (i) =>
        this.state[i] === 'running' &&
        this.questions.some((q) => q.taker === `session:${session(i)}` && !q.answered)
    )
    const index = holders[by % Math.max(holders.length, 1)]
    if (index === undefined) {
      return null
    }
    const open = this.questions.filter(
      (q) => q.taker === `session:${session(index)}` && !q.answered
    )
    const question = open[by % Math.max(open.length, 1)]
    return question ? { index, question } : null
  }

  apply(op: Op): void {
    switch (op.op) {
      case 'ask': {
        if (STOPPED.includes(this.state[op.to]!) && this.state[op.to] !== 'closed') {
          return
        }
        const admitted = this.db.admitBotRequest({
          rootKey: `root-${this.seq++}`,
          fromBotId: 'asker',
          toBotId: `R${op.to}`,
          purpose: 'question',
          depth: 1,
          record: '{}',
          message: {
            from: 'orca_session_id:asker',
            to: this.mailbox(op.to),
            subject: 'q',
            type: 'question'
          }
        })
        if (admitted.kind === 'sent') {
          this.questions.push({ id: admitted.message.id, to: op.to, taker: null, answered: false })
          this.pending.push({ id: admitted.message.id, mailbox: this.mailbox(op.to) })
        }
        return
      }
      case 'status':
      case 'statusToWorker': {
        const worker = op.op === 'statusToWorker' ? this.liveWorker(op.worker) : undefined
        if (
          op.op === 'statusToWorker' &&
          worker?.state !== 'running' &&
          worker?.state !== 'resting'
        ) {
          return
        }
        const to = worker
          ? `dispatch:${worker.dispatchId}`
          : this.mailbox(op.op === 'status' ? op.to % 2 : 0)
        const mail = this.db.insertMessage({ from: 'orca_session_id:asker', to, subject: 'fyi' })
        this.pending.push({ id: mail.id, mailbox: to })
        return
      }
      case 'deliver': {
        const to = this.withMail(this.pending, op.to)
        const ids = this.pendingFor(to)
        const state = this.state[to]!
        if (ids.length === 0 || STOPPED.includes(state)) {
          return
        }
        const taker: MailTaker = { kind: 'session', sessionId: session(to) }
        if (state === 'prompt' || state === 'running') {
          this.take(ids, taker, false)
          this.observe(session(to))
        } else {
          this.state[op.to] = 'running'
          this.take(ids, taker, true)
          this.observe(session(to))
        }
        return
      }
      case 'handover': {
        // A pass reserved this mail and is sending it: no longer selectable, not yet in the chat.
        const to = this.withMail(this.pending, op.to)
        const ids = this.pendingFor(to)
        if (ids.length === 0 || STOPPED.includes(this.state[to]!)) {
          return
        }
        for (const id of ids) {
          this.reserve(id)
        }
        this.handing.push(...this.pending.filter((m) => ids.includes(m.id)))
        this.pending = this.pending.filter((m) => !ids.includes(m.id))
        return
      }
      case 'handoverEnds':
        return this.endHandover(this.withMail(this.handing, op.to), op.end)
      case 'shellCheck':
        return this.take(this.pendingFor(op.to), { kind: 'shell' }, true)
      case 'reply': {
        const held = this.holderOf(op.by + op.pick)
        if (held) {
          this.db.recordBotAnswer(held.question.id)
          if (this.db.getMessageById(held.question.id)?.read === 0) {
            this.db.markAsRead([held.question.id], { kind: 'reply' })
          }
          held.question.answered = true
        }
        return
      }
      case 'rest':
        return this.state[op.who] === 'running' ? this.setState(op.who, 'resting') : undefined
      case 'prompt':
        return this.state[op.who] === 'running' ? this.setState(op.who, 'prompt') : undefined
      case 'resume':
        return this.state[op.who] === 'prompt' ? this.setState(op.who, 'running') : undefined
      case 'close':
        return ['resting', 'prompt'].includes(this.state[op.who]!)
          ? this.setState(op.who, 'closed')
          : undefined
      case 'startLinked': {
        const held = this.holderOf(op.by + op.pick)
        if (!held) {
          return
        }
        const link = linkWorkerToQuestion(
          this.db,
          held.question.id,
          {
            address: this.mailbox(held.index),
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: testOrcaSessionId(session(held.index))
          },
          false
        )
        if (!link.linked) {
          return
        }
        const task = this.db.createTask({ spec: 'answer it', runId: this.runId })
        const started = this.db.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskId: task.id,
          startOptions: {},
          forMessageId: held.question.id
        })
        link.take?.(true)
        this.workers.push({
          dispatchId: started.dispatch.id,
          question: held.question.id,
          state: 'starting'
        })
        return
      }
      case 'startHelper': {
        const parent = this.liveWorker(op.worker)
        if (parent?.state !== 'running') {
          return
        }
        const task = this.db.createTask({ spec: 'helper', runId: this.runId })
        const started = this.db.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskId: task.id,
          startOptions: {}
        })
        this.db.db
          .prepare('UPDATE dispatch_contexts SET creator_dispatch_id = ? WHERE id = ?')
          .run(parent.dispatchId, started.dispatch.id)
        this.workers.push({
          dispatchId: started.dispatch.id,
          question: parent.question,
          state: 'starting'
        })
        return
      }
      case 'workerReady': {
        const worker = this.liveWorker(op.worker)
        if (worker?.state !== 'starting') {
          return
        }
        // A chat worker: its Dispatch names its session.
        this.db.db
          .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
          .run(`W-${worker.dispatchId}`, worker.dispatchId)
        worker.state = 'running'
        this.db.markWorkerDispatchReady(worker.dispatchId)
        return
      }
      case 'workerRest':
      case 'workerWake': {
        const worker = this.liveWorker(op.worker)
        if (worker?.state !== 'running' && worker?.state !== 'resting') {
          return
        }
        if (op.op === 'workerWake') {
          const mailbox = `dispatch:${worker.dispatchId}`
          const ids = this.pending.filter((m) => m.mailbox === mailbox).map((m) => m.id)
          if (ids.length > 0) {
            this.db.markAsRead(ids, { kind: 'session', sessionId: `W-${worker.dispatchId}` })
            this.pending = this.pending.filter((m) => !ids.includes(m.id))
          }
        }
        worker.state = op.op === 'workerWake' ? 'running' : 'resting'
        this.observe(`W-${worker.dispatchId}`)
        return
      }
      case 'workerEnd': {
        const worker = this.liveWorker(op.worker)
        if (!worker) {
          return
        }
        worker.state = 'ended'
        this.pending = this.pending.filter((m) => m.mailbox !== `dispatch:${worker.dispatchId}`)
        if (
          op.failed ||
          !this.db.getDispatchContextById(worker.dispatchId)?.assignee_orca_session_id
        ) {
          this.db.failDispatch(worker.dispatchId, 'worker exited', { workerProcessExited: true })
        } else {
          this.db.completeDispatch(worker.dispatchId)
        }
        return
      }
      case 'pause':
      case 'delete': {
        const state = this.state[op.who]!
        if (state === 'paused' || state === 'deleted') {
          return
        }
        this.state[op.who] = op.op === 'pause' ? 'paused' : 'deleted'
        // As dropUnreadBotRequests: questions not being handed over are dropped as takes.
        const why = op.op === 'pause' ? 'paused' : 'deleted'
        const unread = this.questions.filter(
          (q) =>
            q.taker === null &&
            q.to === op.who &&
            !this.handing.some((m) => m.id === q.id) &&
            this.db.getMessageById(q.id)?.read === 0
        )
        this.take(
          unread.map((q) => q.id),
          { kind: 'dropped', why },
          true
        )
        if (SKIP !== 'E7') {
          this.reconciler.decideAll()
        }
        return
      }
      case 'unpause':
        return this.state[op.who] === 'paused' ? this.setState(op.who, 'resting') : undefined
      case 'crash':
        return this.restart()
      case 'lostEdgeThenCrash':
        this.edgesLive = false
        this.stop()
        try {
          this.apply(op.inner)
        } finally {
          this.edgesLive = true
        }
        return this.restart()
    }
  }

  endHandover(to: number, end: HandoverEnd): void {
    const ended = this.handing.filter((m) => m.mailbox === this.mailbox(to))
    if (ended.length === 0) {
      return
    }
    this.handing = this.handing.filter((m) => !ended.includes(m))
    const ids = ended.map((m) => m.id)
    const taker: MailTaker = { kind: 'session', sessionId: session(to) }
    if (end === 'refused') {
      for (const id of ids) {
        this.db.releaseStructuredMailSend(this.reserve(id))
      }
      this.pending.push(...ended)
    } else if (
      (end === 'turn' || (end === 'queued' && this.state[to] === 'resting')) &&
      !STOPPED.includes(this.state[to]!)
    ) {
      // A card queued to a chat at rest starts its turn at once.
      this.state[to] = 'running'
      this.db.markAsRead(ids, taker)
      this.take(ids, taker, true)
    } else if (end === 'queued' && !STOPPED.includes(this.state[to]!)) {
      // Behind the running turn, or a person's prompt.
      this.take(ids, taker, false)
    }
    // 'stuck': the send row stays and the mail stays unread; nothing reads it again.
    if (this.edgesLive) {
      // The pass ends however its send ended (structured-mailbox-pointer-delivery `finally`).
      noteQuestionEdge({ kind: 'mailbox', mailbox: this.mailbox(to) })
    }
    if (end === 'turn' || end === 'queued') {
      // Only a card the chat took changes its journal.
      this.observe(session(to))
    }
  }

  restart(): void {
    this.stop()
    this.db.close()
    this.handing = []
    this.db = new OrchestrationDb(this.file)
    this.startReconciler()
  }

  check(after: string): void {
    for (const question of this.questions) {
      const count = this.told.get(question.id) ?? 0
      if (count > 1) {
        this.violations.push({ kind: 'duplicate', detail: `${question.id} told ${count} times` })
      }
      if (question.answered || count > 0 || question.taker === null) {
        continue
      }
      if (!this.busy(question.taker, question.id)) {
        this.violations.push({
          kind: 'stranded',
          detail: `${question.id} taken by ${question.taker}, nothing will wake it, untold, after ${after}`
        })
      }
    }
  }

  dispose(): void {
    this.stop()
    this.db.close()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

async function quiesce(world: World): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await world.reconciler.settled()
  }
}

const stats = { questions: 0, answered: 0, told: 0, linked: 0 }

async function runSequence(ops: Op[], record = false): Promise<Violation[]> {
  const world = new World()
  try {
    for (const [index, op] of ops.entries()) {
      world.apply(op)
      await quiesce(world)
      world.check(`step ${index} ${JSON.stringify(op)}`)
      if (world.violations.length > 0) {
        break
      }
    }
    if (record) {
      stats.questions += world.questions.length
      stats.answered += world.questions.filter((q) => q.answered).length
      stats.told += world.told.size
      stats.linked += world.workers.length
    }
    return world.violations
  } finally {
    world.dispose()
  }
}

describe('agent questions: random-ordering invariants', () => {
  it('tells every question its taker stopped on exactly once, never while a wake is pending', async () => {
    const sequences = Number(process.env.AQ_SEQS ?? 150)
    const found = new Map<string, { count: number; minimal: Op[]; detail: string }>()
    let opsRun = 0
    for (let seed = 1; seed <= sequences; seed++) {
      const random = rng(seed)
      const ops = Array.from(
        { length: 10 + Math.floor(random() * Number(process.env.AQ_MAXLEN ?? 40)) },
        () => randomOp(random)
      )
      opsRun += ops.length
      const violation = (await runSequence(ops, true))[0]
      if (!violation) {
        continue
      }
      const seen = found.get(violation.kind)
      if (seen) {
        seen.count++
        continue
      }
      const minimal = await shrink(ops, violation.kind, runSequence)
      const replay = (await runSequence(minimal)).find((v) => v.kind === violation.kind)
      found.set(violation.kind, { count: 1, minimal, detail: replay?.detail ?? violation.detail })
    }
    const report = [
      `sequences: ${sequences}, ops: ${opsRun}, skipped edge: ${SKIP || 'none'}`,
      `stats: ${JSON.stringify(stats)}`,
      ...[...found].map(
        ([kind, { count, minimal, detail }]) =>
          `${kind}: ${count} sequence(s)\n  ${detail}\n  minimal:\n    ${minimal.map((op) => JSON.stringify(op)).join('\n    ')}`
      )
    ].join('\n')
    if (process.env.AQ_REPORT) {
      writeFileSync(process.env.AQ_REPORT, report)
    }
    expect(found.size, report).toBe(0)
    expect(stats.told, report).toBeGreaterThan(0)
  }, 600_000)
})
