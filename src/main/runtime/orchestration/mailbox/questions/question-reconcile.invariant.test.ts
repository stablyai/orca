// SPIKE, not for merge: random-ordering invariant harness for the shadow reconcile.
// Real OrchestrationDb (a file, so a crash reopens it), real takes, answers and dispatch transitions;
// the world (who runs, who is paused, which workers run) is an independent model the host reports from.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  questionTakeListeners,
  stampQuestionTakes,
  type MailTaker
} from '../../db/messages/mail-taker'
import { linkWorkerToQuestion } from '../../../rpc/methods/orchestration/worker/start/worker-question-link'
import type { OrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import {
  awaitingTakers,
  ensureShadowTable,
  reconcileQuestions,
  takersLinkedTo,
  type ReconcileHost
} from './question-reconcile'
import {
  COORDINATOR,
  RECEIVERS,
  randomOp,
  rng,
  shrink,
  type Op
} from './question-reconcile-invariant-ops'

type PartyState = 'resting' | 'running' | 'prompt' | 'closed' | 'paused' | 'deleted' | 'unpaired'

type Question = {
  id: string
  kind: 'bot' | 'worker-ask'
  to: number
  taker: string | null
  answered: boolean
}
type Worker = {
  dispatchId: string
  question: string
  state: 'starting' | 'running' | 'resting' | 'ended'
}

type Violation = { kind: string; detail: string }

class World {
  dir = mkdtempSync(path.join(tmpdir(), 'aq-inv-'))
  file = path.join(this.dir, 'orchestration.db')
  db = new OrchestrationDb(this.file)
  state: PartyState[] = Array.from({ length: RECEIVERS }, () => 'resting' as PartyState)
  bound = true
  runId: string
  askDispatch: string
  questions: Question[] = []
  workers: Worker[] = []
  violations: Violation[] = []
  edgesLive = true
  seq = 0

  constructor() {
    ensureShadowTable(this.db)
    const run = this.db.createRun({
      objective: 'invariant',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    this.runId = run.id
    const task = this.db.createTask({ spec: 'asker', runId: run.id })
    const asker = this.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    this.askDispatch = asker.dispatch.id
    this.db.markWorkerDispatchReady(this.askDispatch)
  }

  partyKey(index: number): string {
    return `session:R${index}`
  }
  mailbox(index: number): string {
    return `orca_session_id:R${index}`
  }
  workerParty(worker: Worker): string {
    return `session:W-${worker.dispatchId}`
  }
  mailboxesOf(index: number): string[] {
    return index === COORDINATOR && this.bound
      ? [this.mailbox(index), `run:${this.runId}`]
      : [this.mailbox(index)]
  }

  // ---- the host, as a real runtime would report it ----
  host: ReconcileHost = {
    running: (party) => {
      const receiver = this.receiverOf(party)
      if (receiver !== null) {
        return this.state[receiver] === 'running'
      }
      return this.workerOf(party)?.state === 'running'
    },
    canAttach: (party) => {
      const receiver = this.receiverOf(party)
      if (receiver !== null) {
        return !['paused', 'deleted', 'unpaired'].includes(this.state[receiver]!)
      }
      const worker = this.workerOf(party)
      return worker !== undefined && worker.state !== 'ended'
    },
    mailboxes: (party) => {
      const receiver = this.receiverOf(party)
      if (receiver !== null) {
        return this.mailboxesOf(receiver)
      }
      const worker = this.workerOf(party)
      return worker ? [`dispatch:${worker.dispatchId}`] : []
    },
    dispatchParty: (dispatchId) => {
      const worker = this.workers.find((w) => w.dispatchId === dispatchId)
      return worker && worker.state !== 'starting' ? this.workerParty(worker) : null
    }
  }

  receiverOf(party: string): number | null {
    const match = /^session:R(\d)$/.exec(party)
    return match ? Number(match[1]) : null
  }
  workerOf(party: string): Worker | undefined {
    return this.workers.find((w) => this.workerParty(w) === party)
  }

  // ---- ground truth, from the model only ----
  modelUndelivered(mailbox: string): boolean {
    return this.pendingMail.some((mail) => mail.mailbox === mailbox)
  }
  pendingMail: { id: string; mailbox: string; question: boolean }[] = []

  modelBusy(party: string): string | null {
    if (/^(shell|reply|orca|dropped:.*)$/.test(party)) {
      return null
    }
    if (this.host.running(party)) {
      return 'running'
    }
    return this.host.canAttach(party) &&
      this.host.mailboxes(party).some((m) => this.modelUndelivered(m))
      ? 'wake pending'
      : null
  }
  modelLinkedBusy(question: string): string | null {
    for (const worker of this.workers) {
      if (worker.question !== question || worker.state === 'ended') {
        continue
      }
      if (worker.state === 'starting') {
        return 'linked starting'
      }
      const busy = this.modelBusy(this.workerParty(worker))
      if (busy) {
        return `linked ${busy}`
      }
    }
    return null
  }

  decisionCount(id: string): number {
    return (
      this.db.db
        .prepare('SELECT COUNT(*) AS n FROM question_shadow_decisions WHERE message_id = ?')
        .get(id) as { n: number }
    ).n
  }

  // ---- edges ----
  reconcile(party: string): void {
    if (!this.edgesLive) {
      return
    }
    for (const decision of reconcileQuestions(this.db, this.host, party)) {
      const question = this.questions.find((q) => q.id === decision.messageId)
      const why =
        this.modelBusy(decision.taker) ?? (question ? this.modelLinkedBusy(question.id) : null)
      if (why) {
        this.violations.push({
          kind: 'early',
          detail: `${decision.messageId} notified while ${decision.taker}: ${why}`
        })
      }
    }
  }
  reconcileLinked(dispatchId: string): void {
    for (const taker of takersLinkedTo(this.db, dispatchId)) {
      this.reconcile(taker)
    }
  }
  takeListener = (taker: string): void => this.reconcile(taker)

  // ---- operations ----
  take(ids: string[], taker: MailTaker, read: boolean): void {
    if (ids.length === 0) {
      return
    }
    if (read) {
      this.db.markAsRead(ids, taker)
    } else {
      // A card queued behind a person, or a pointer typed in: taken, still unread.
      this.db.db.exec('SAVEPOINT take')
      stampQuestionTakes(this.db, ids, taker)
      this.db.db.exec('RELEASE take')
      for (const mailbox of new Set(
        this.pendingMail.filter((m) => ids.includes(m.id)).map((m) => m.mailbox)
      )) {
        this.db.markAsDelivered(ids, mailbox)
      }
    }
    const key =
      taker.kind === 'session'
        ? `session:${taker.sessionId}`
        : taker.kind === 'dropped'
          ? `dropped:${taker.why}`
          : taker.kind
    for (const question of this.questions) {
      if (ids.includes(question.id) && question.taker === null) {
        question.taker = key
      }
    }
    const drained = new Set(
      this.pendingMail.filter((m) => ids.includes(m.id)).map((m) => m.mailbox)
    )
    this.pendingMail = this.pendingMail.filter((m) => !ids.includes(m.id))
    this.mailboxDrained(drained)
  }

  /** E12 (found by this harness): mail left a mailbox, so a wake its readers were held on may be gone. */
  mailboxDrained(mailboxes: ReadonlySet<string>): void {
    if (MUTATE === 'no-E12' || mailboxes.size === 0) {
      return
    }
    queueMicrotask(() => {
      for (let i = 0; i < RECEIVERS; i++) {
        if (this.mailboxesOf(i).some((m) => mailboxes.has(m))) {
          this.reconcile(this.partyKey(i))
        }
      }
      for (const worker of this.workers) {
        if (mailboxes.has(`dispatch:${worker.dispatchId}`)) {
          this.reconcileLinked(worker.dispatchId)
        }
      }
    })
  }

  setState(index: number, next: PartyState): void {
    this.state[index] = next
    if (MUTATE !== 'no-E1') {
      this.reconcile(this.partyKey(index)) // E1
    }
  }

  liveWorker(index: number): Worker | undefined {
    const live = this.workers.filter((w) => w.state !== 'ended')
    return live[index % Math.max(live.length, 1)]
  }

  apply(op: Op): void {
    switch (op.op) {
      case 'ask': {
        if (['paused', 'deleted', 'unpaired'].includes(this.state[op.to]!)) {
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
        if (admitted.kind !== 'sent') {
          return
        }
        this.questions.push({
          id: admitted.message.id,
          kind: 'bot',
          to: op.to,
          taker: null,
          answered: false
        })
        this.pendingMail.push({
          id: admitted.message.id,
          mailbox: this.mailbox(op.to),
          question: true
        })
        return
      }
      case 'workerAsk': {
        const { message } = this.db.createQuestion({
          runId: this.runId,
          dispatchId: this.askDispatch,
          askerHandle: 'term_asker',
          question: 'which?'
        })
        this.questions.push({
          id: message.id,
          kind: 'worker-ask',
          to: COORDINATOR,
          taker: null,
          answered: false
        })
        if (this.bound) {
          this.pendingMail.push({ id: message.id, mailbox: `run:${this.runId}`, question: true })
        } else {
          // E10: no one reads the Run's mail.
          this.take([message.id], { kind: 'dropped', why: 'no-reader' }, false)
        }
        return
      }
      case 'status': {
        if (['deleted', 'unpaired'].includes(this.state[op.to]!)) {
          return
        }
        const mail = this.db.insertMessage({
          from: 'orca_session_id:asker',
          to: this.mailbox(op.to),
          subject: 'fyi'
        })
        this.pendingMail.push({ id: mail.id, mailbox: this.mailbox(op.to), question: false })
        return
      }
      case 'statusToWorker': {
        const worker = this.liveWorker(op.worker)
        if (!worker || worker.state === 'ended') {
          return
        }
        const mail = this.db.insertMessage({
          from: 'term_coord',
          to: `dispatch:${worker.dispatchId}`,
          subject: 'fyi'
        })
        this.pendingMail.push({
          id: mail.id,
          mailbox: `dispatch:${worker.dispatchId}`,
          question: false
        })
        this.reconcileLinked(worker.dispatchId) // a pending wake: nothing may be told
        return
      }
      case 'deliver': {
        const waiting = [0, 1, 2].filter((i) =>
          this.pendingMail.some((m) => this.mailboxesOf(i).includes(m.mailbox))
        )
        const to = waiting[op.to % Math.max(waiting.length, 1)] ?? op.to
        const state = this.state[to]!
        if (['paused', 'deleted', 'unpaired'].includes(state)) {
          return
        }
        const ids = this.pendingMail
          .filter((m) => this.mailboxesOf(to).includes(m.mailbox))
          .map((m) => m.id)
        if (ids.length === 0) {
          return
        }
        const taker: MailTaker = { kind: 'session', sessionId: `R${to}` }
        if (state === 'prompt' || state === 'running') {
          this.take(ids, taker, false) // queued as a card; read on its next turn
          this.reconcile(this.partyKey(to)) // E6: the pass ended without a turn
        } else {
          this.state[to] = 'running'
          this.take(ids, taker, true)
          this.reconcile(this.partyKey(to)) // E1 (running)
        }
        return
      }
      case 'shellCheck': {
        const ids = this.pendingMail
          .filter((m) => m.mailbox === this.mailbox(op.to))
          .map((m) => m.id)
        this.take(ids, { kind: 'shell' }, true)
        return
      }
      case 'reply': {
        const holders = [0, 1, 2].filter(
          (i) =>
            this.state[i] === 'running' &&
            this.questions.some((q) => q.taker === this.partyKey(i) && !q.answered)
        )
        const by = holders[op.by % Math.max(holders.length, 1)]
        if (by === undefined) {
          return
        }
        const open = this.questions.filter((q) => q.taker === this.partyKey(by) && !q.answered)
        const question = open[op.pick % Math.max(open.length, 1)]
        if (!question) {
          return
        }
        if (question.kind === 'bot') {
          this.db.recordBotAnswer(question.id)
          if (this.db.getMessageById(question.id)?.read === 0) {
            this.db.markAsRead([question.id], { kind: 'reply' })
          }
        } else {
          const run = this.db.getRun(this.runId)!
          this.db.answerQuestion({
            messageId: question.id,
            runId: this.runId,
            body: 'this one',
            consumerGeneration: run.consumer_generation
          })
        }
        question.answered = true
        return
      }
      case 'rest':
        if (this.state[op.who] === 'running') {
          this.setState(op.who, 'resting')
        }
        return
      case 'prompt':
        if (this.state[op.who] === 'running') {
          this.setState(op.who, 'prompt')
        }
        return
      case 'resume':
        if (this.state[op.who] === 'prompt') {
          this.setState(op.who, 'running')
        }
        return
      case 'close':
        if (this.state[op.who] === 'resting' || this.state[op.who] === 'prompt') {
          this.setState(op.who, 'closed')
        }
        return
      case 'startLinked': {
        const holders = [0, 1, 2].filter(
          (i) =>
            this.state[i] === 'running' &&
            this.questions.some((q) => q.taker === this.partyKey(i) && !q.answered)
        )
        const by = holders[op.by % Math.max(holders.length, 1)]
        if (by === undefined) {
          return
        }
        const open = this.questions.filter((q) => q.taker === this.partyKey(by) && !q.answered)
        const question = open[op.pick % Math.max(open.length, 1)]
        if (!question) {
          return
        }
        const link = linkWorkerToQuestion(
          this.db,
          question.id,
          {
            address: this.mailbox(by),
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: `R${by}` as OrcaSessionId
          },
          false
        )
        const task = this.db.createTask({ spec: 'answer it', runId: this.runId })
        const started = this.db.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskId: task.id,
          startOptions: {},
          ...(link.linked ? { forMessageId: question.id } : {})
        })
        if (link.linked) {
          link.take?.()
          this.workers.push({
            dispatchId: started.dispatch.id,
            question: question.id,
            state: 'starting'
          })
        }
        return
      }
      case 'workerReady': {
        const worker = this.liveWorker(op.worker)
        if (worker?.state !== 'starting') {
          return
        }
        this.db.markWorkerDispatchReady(worker.dispatchId)
        worker.state = 'running'
        this.reconcileLinked(worker.dispatchId) // E5
        return
      }
      case 'workerRest':
      case 'workerWake': {
        const worker = this.liveWorker(op.worker)
        if (!worker || worker.state === 'ended' || worker.state === 'starting') {
          return
        }
        if (op.op === 'workerWake') {
          // A pass hands it its mail: it runs.
          const ids = this.pendingMail
            .filter((m) => m.mailbox === `dispatch:${worker.dispatchId}`)
            .map((m) => m.id)
          if (ids.length > 0) {
            this.db.markAsRead(ids, { kind: 'session', sessionId: `W-${worker.dispatchId}` })
            this.pendingMail = this.pendingMail.filter((m) => !ids.includes(m.id))
          }
          worker.state = 'running'
        } else {
          worker.state = 'resting'
        }
        this.reconcileLinked(worker.dispatchId) // E1 for a linked party
        return
      }
      case 'workerEnd': {
        const worker = this.liveWorker(op.worker)
        if (!worker || worker.state === 'ended') {
          return
        }
        const takers = takersLinkedTo(this.db, worker.dispatchId)
        if (op.failed || worker.state === 'starting') {
          this.db.failDispatch(worker.dispatchId, 'worker exited', { workerProcessExited: true })
        } else {
          this.db.completeDispatch(worker.dispatchId)
        }
        worker.state = 'ended'
        this.pendingMail = this.pendingMail.filter(
          (m) => m.mailbox !== `dispatch:${worker.dispatchId}`
        )
        for (const taker of MUTATE === 'no-E5' ? [] : takers) {
          this.reconcile(taker) // E5
        }
        return
      }
      case 'pause':
      case 'delete': {
        if (
          op.who === COORDINATOR ||
          ['paused', 'deleted', 'unpaired'].includes(this.state[op.who]!)
        ) {
          return
        }
        const why = op.op === 'pause' ? 'paused' : 'deleted'
        this.state[op.who] = op.op === 'pause' ? 'paused' : 'deleted'
        const unread = this.pendingMail
          .filter((m) => m.mailbox === this.mailbox(op.who))
          .map((m) => m.id)
        // E7: drop what it never read, read in the drop.
        this.take(unread, { kind: 'dropped', why }, true)
        this.reconcile(this.partyKey(op.who))
        return
      }
      case 'unpause':
        if (this.state[op.who] === 'paused') {
          this.setState(op.who, 'resting')
        }
        return
      case 'unbind': {
        if (!this.bound) {
          return
        }
        this.bound = false
        const unread = this.pendingMail
          .filter((m) => m.mailbox === `run:${this.runId}`)
          .map((m) => m.id)
        this.take(unread, { kind: 'dropped', why: 'no-reader' }, false)
        this.pendingMail = this.pendingMail.filter((m) => m.mailbox !== `run:${this.runId}`)
        this.reconcile(this.partyKey(COORDINATOR))
        return
      }
      case 'unpair': {
        // The receiver sat on a paired computer that was removed: its unread stays unread, dropped.
        if (
          op.who === COORDINATOR ||
          ['paused', 'deleted', 'unpaired'].includes(this.state[op.who]!)
        ) {
          return
        }
        this.state[op.who] = 'unpaired'
        const unread = this.pendingMail
          .filter((m) => m.mailbox === this.mailbox(op.who))
          .map((m) => m.id)
        this.take(unread, { kind: 'dropped', why: 'unpaired' }, false)
        this.pendingMail = this.pendingMail.filter((m) => m.mailbox !== this.mailbox(op.who))
        this.reconcile(this.partyKey(op.who)) // E11
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
        // SPIKE: the creator link a helper start records from its live caller.
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
      case 'crash':
        this.restart()
        return
      case 'lostEdgeThenCrash':
        this.edgesLive = false
        try {
          this.apply(op.inner)
        } finally {
          this.edgesLive = true
        }
        this.restart()
    }
  }

  restart(): void {
    this.db.close()
    this.db = new OrchestrationDb(this.file)
    ensureShadowTable(this.db)
    // E9: every taker still holding a question.
    for (const taker of MUTATE === 'no-E9' ? [] : awaitingTakers(this.db)) {
      this.reconcile(taker)
    }
  }

  checkQuiescent(after: string): void {
    for (const question of this.questions) {
      const count = this.decisionCount(question.id)
      if (count > 1) {
        this.violations.push({
          kind: 'duplicate',
          detail: `${question.id} notified ${count} times`
        })
      }
      if (question.answered || count === 1) {
        continue
      }
      if (question.taker === null) {
        // Untaken: only a receiver that can never take it is stopped.
        const mailboxOpen =
          question.kind === 'bot'
            ? !['paused', 'deleted', 'unpaired'].includes(this.state[question.to]!)
            : this.bound
        if (!mailboxOpen) {
          this.violations.push({
            kind: 'stranded-untaken',
            detail: `${question.id} (${question.kind}) after ${after}`
          })
        }
        continue
      }
      if (this.modelBusy(question.taker) || this.modelLinkedBusy(question.id)) {
        continue
      }
      this.violations.push({
        kind: `stranded-${question.kind}`,
        detail: `${question.id} taken by ${question.taker}, nothing running, not told, after ${after}`
      })
    }
  }

  dispose(): void {
    this.db.close()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

const stats = {
  questions: 0,
  answered: 0,
  notified: 0,
  notifiedWorkerAsk: 0,
  linked: 0,
  crashes: 0
}
const MUTATE = process.env.AQ_MUTATE ?? ''

async function runSequence(ops: Op[], record = false): Promise<Violation[]> {
  const world = new World()
  questionTakeListeners.add(world.takeListener)
  try {
    for (const [index, op] of ops.entries()) {
      world.apply(op)
      await Promise.resolve() // let E4 (post-commit take listeners) run
      await Promise.resolve()
      world.checkQuiescent(`step ${index} ${JSON.stringify(op)}`)
      if (world.violations.length > 0) {
        return world.violations
      }
    }
    return world.violations
  } finally {
    if (record) {
      stats.questions += world.questions.length
      stats.answered += world.questions.filter((q) => q.answered).length
      stats.notified += world.questions.filter((q) => world.decisionCount(q.id) > 0).length
      stats.notifiedWorkerAsk += world.questions.filter(
        (q) => q.kind === 'worker-ask' && world.decisionCount(q.id) > 0
      ).length
      stats.linked += world.workers.length
      stats.crashes += ops.filter((op) => op.op === 'crash' || op.op === 'lostEdgeThenCrash').length
    }
    questionTakeListeners.delete(world.takeListener)
    world.dispose()
  }
}

describe('shadow reconcile: random-ordering invariants', () => {
  it('tells every stopped question exactly once, and never while a wake is provably pending', async () => {
    const sequences = Number(process.env.AQ_SEQS ?? 300)
    const byKind = new Map<string, { count: number; minimal: Op[]; detail: string }>()
    let opsRun = 0
    for (let seed = 1; seed <= sequences; seed++) {
      const random = rng(seed)
      const length = 10 + Math.floor(random() * Number(process.env.AQ_MAXLEN ?? 50))
      const ops = Array.from({ length }, () => randomOp(random))
      opsRun += ops.length
      const violations = await runSequence(ops, true)
      for (const violation of violations.slice(0, 1)) {
        const seen = byKind.get(violation.kind)
        if (seen) {
          seen.count++
          continue
        }
        const minimal = await shrink(ops, violation.kind, runSequence)
        const replay = await runSequence(minimal)
        byKind.set(violation.kind, {
          count: 1,
          minimal,
          detail: replay.find((v) => v.kind === violation.kind)?.detail ?? violation.detail
        })
      }
    }
    const report = [
      `sequences: ${sequences}, ops: ${opsRun}, mutation: ${MUTATE || 'none'}`,
      `stats: ${JSON.stringify(stats)}`,
      ...[...byKind].map(
        ([kind, { count, minimal, detail }]) =>
          `${kind}: ${count} sequence(s)\n  ${detail}\n  minimal: ${minimal.map((op) => JSON.stringify(op)).join('\n           ')}`
      )
    ].join('\n')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.AQ_REPORT ?? path.join(tmpdir(), 'aq-invariant-report.txt'), report)
    expect(report).not.toMatch(/: \d+ sequence/)
  }, 3_600_000)
})
