// One in-memory reconciliation worker per chat: what ended generations left, and what an earlier
// host process left, settled in the background after every signal that a generation ended.
//
// Signals: every committed revocation or supersession of a generation (the record store's
// `onGenerationEnded`), an exit this host observed (whether or not its release landed), a row an
// ended generation committed late, and startup. Each one re-derives what readers see at once (the
// operational revision, the published view, the queued-card drain), then wakes the worker.
//
// The worker coalesces: a chat has at most one attempt running and one timer waiting, and every
// attempt re-derives everything owed (`runStructuredAgentSessionReconciliationPass`). A chat nobody
// has open is replayed in one of a few background slots outside its lane, as the worker's own read
// (`structured-agent-session-reconciliation-load.ts`): never the chat's conversation, so nothing it
// writes is published and nothing it closes was anyone's. Only the pass takes the lane, so a send
// that arrived meanwhile goes first; a chat a reader opens moves ahead of the rest of the scan.
// A failure backs off from 1 s to 30 s, in memory only, and is given up after a bounded run of
// them: the next signal or the next startup derives whatever is still owed again. The worker
// retires once a pass finds nothing owed and wrote nothing, when the chat's record is gone or its
// journal can never load, when the database is read-only, or at shutdown. Nothing a person does
// (send, start, open, Stop, answer) ever waits on it.

import type { AgentSessionGenerationEnd } from '../../runtime/agent-session-generation-end'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionExitSettlement } from './structured-agent-session-leftover-settlement'
import {
  runStructuredAgentSessionReconciliationPass,
  type StructuredAgentSessionReconciliationDebts,
  type StructuredAgentSessionReconciliationPassContext
} from './structured-agent-session-reconciliation-pass'
import {
  loadStructuredAgentSessionForReconciliation,
  structuredAgentSessionJournalIsCurrent
} from './structured-agent-session-reconciliation-load'
import {
  StructuredAgentSessionReconciliationSlots,
  type StructuredAgentSessionReconciliationSlotWaiter
} from './structured-agent-session-reconciliation-slots'

export const RECONCILIATION_BACKOFF_MS = { first: 1_000, max: 30_000 } as const
/** Consecutive failed attempts after which the worker gives up (about three minutes of backoff). */
export const RECONCILIATION_MAX_FAILED_ATTEMPTS = 10

export type StructuredAgentSessionReconciliationSignal = {
  /** Proof the lease no longer holds (`AgentSessionGenerationEnd.evidence`). */
  evidence?: AgentSessionGenerationEnd['evidence']
  /** An observed exit whose own settlement did not land. */
  exit?: StructuredAgentSessionExitSettlement
  /** Readers re-baseline at the moved fence (`publishGenerationEnded`). */
  restate?: boolean
  /** This process owes the chat its startup share. */
  startup?: true
}

export type StructuredAgentSessionReconciliationContext =
  StructuredAgentSessionReconciliationPassContext & {
    deps: StructuredAgentSessionReconciliationPassContext['deps']
    /** The chat's action lane. */
    serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
    /** Lets a quit wait for an attempt already writing. */
    track: <T>(operation: Promise<T>) => Promise<T>
    /** Publishes what is current now and wakes the queued-card drain. */
    publishGenerationEnded: (sessionId: string, options?: { restate?: boolean }) => void
    /** Exits a lease latched in recovery when present-time evidence permits; a no-op otherwise. */
    resolveRecovery: (sessionId: string) => Promise<unknown>
  }

/** `done`: a pass found nothing owed, unless a signal came meanwhile; `retire`: nothing this
 *  worker can do, whatever came meanwhile (a later signal starts a new one). */
type Outcome = 'done' | 'retire' | 'again' | 'failed'

type ChatWorker = StructuredAgentSessionReconciliationSlotWaiter & {
  debts: StructuredAgentSessionReconciliationDebts
  running: boolean
  /** A signal arrived while an attempt ran: the next attempt follows at once. */
  dirty: boolean
  /** `soon`: an attempt queued for this turn of the event loop; else a backoff's timer. */
  timer: ReturnType<typeof setTimeout> | 'soon' | null
  failures: number
  attempted: (() => void)[]
  /** The worker's own read of the chat while nobody has it open; closed when it retires. */
  loaded?: StructuredAgentSessionHostSession
}

export class StructuredAgentSessionReconciliation {
  private readonly workers = new Map<string, ChatWorker>()
  private disposed = false
  private readonly slots = new StructuredAgentSessionReconciliationSlots(() => this.disposed)
  private readonly unsubscribe: () => void

  constructor(private readonly context: StructuredAgentSessionReconciliationContext) {
    this.unsubscribe = context.deps.store.onGenerationEnded((ended) =>
      this.signal(ended.sessionId, { evidence: ended.evidence })
    )
  }

  signal = (sessionId: string, signal: StructuredAgentSessionReconciliationSignal = {}): void => {
    const session = this.context.sessions.get(sessionId)
    if (session) {
      session.operationalRevision = (session.operationalRevision ?? 0) + 1
    }
    this.context.publishGenerationEnded(sessionId, signal.restate ? { restate: true } : {})
    if (this.disposed) {
      return
    }
    const worker = this.workerFor(sessionId)
    if (signal.evidence) {
      worker.debts.evidence = [...(worker.debts.evidence ?? []), signal.evidence]
    }
    if (signal.exit) {
      worker.debts.exit = signal.exit
    }
    if (signal.startup && !worker.debts.startupShare) {
      worker.debts.startupShare = { leaseSettled: false }
    }
    if (worker.running) {
      worker.dirty = true
    } else if (worker.failures === 0 && !worker.timer) {
      // Coalesced with whatever else this tick signals; during a backoff the timer runs it.
      this.schedule(sessionId, worker, 0)
    }
  }

  /** A committed row below the lease's fence: a generation that ended wrote it late. */
  observeCommit = (sessionId: string, lowestFence: number | null): void => {
    const fence = this.context.deps.store.getRecord(sessionId)?.lease.runtimeFence
    if (lowestFence !== null && fence !== undefined && lowestFence < fence) {
      this.signal(sessionId)
    }
  }

  /** A reader opened the chat: whatever its worker still waits a slot for goes ahead of the scan. */
  prioritize = (sessionId: string): void => {
    const worker = this.workers.get(sessionId)
    if (worker) {
      this.slots.prioritize(worker)
    }
  }

  /** Resolves once the chat's next attempt finished, or at once when it has no worker. */
  attempted = (sessionId: string): Promise<void> => {
    const worker = this.workers.get(sessionId)
    return worker ? new Promise((resolve) => worker.attempted.push(resolve)) : Promise.resolve()
  }

  /** Whether the chat has a worker: something was owed at its last attempt. */
  owes = (sessionId: string): boolean => this.workers.has(sessionId)

  /** Resolves once the chat's worker retired, or is waiting out a backoff. */
  idle = async (sessionId: string): Promise<void> => {
    for (;;) {
      const worker = this.workers.get(sessionId)
      if (!worker || (!worker.running && worker.failures > 0)) {
        return
      }
      await new Promise<void>((resolve) => worker.attempted.push(resolve))
    }
  }

  /** Shutdown: every timer stops and every slot wait ends; an attempt already writing finishes,
   *  tracked, and one that has not started work starts none. */
  dispose = (): void => {
    this.disposed = true
    this.unsubscribe()
    for (const [sessionId, worker] of this.workers) {
      worker.slotWait?.abort()
      this.retire(sessionId, worker)
    }
  }

  private workerFor(sessionId: string): ChatWorker {
    let worker = this.workers.get(sessionId)
    if (!worker) {
      worker = {
        debts: {},
        running: false,
        dirty: false,
        timer: null,
        failures: 0,
        attempted: [],
        urgent: false
      }
      this.workers.set(sessionId, worker)
    }
    return worker
  }

  private attempt(sessionId: string): void {
    const worker = this.workers.get(sessionId)
    if (!worker || worker.running) {
      return
    }
    worker.timer = null
    worker.running = true
    worker.dirty = false
    void this.context
      .track(this.runAttempt(sessionId, worker))
      .then((outcome) => this.afterAttempt(sessionId, worker, outcome))
  }

  private async runAttempt(sessionId: string, worker: ChatWorker): Promise<Outcome> {
    try {
      const { store } = this.context.deps
      if (this.disposed || store.readOnly || !store.getRecord(sessionId)) {
        return 'retire'
      }
      const share = worker.debts.startupShare
      // Once per startup share, before its pass: a lease latched in recovery is decided first, as
      // the restore decides it, so the pass judges what is current.
      if (share && !share.leaseSettled) {
        const resolved = await this.slots.run(worker, () =>
          this.context.resolveRecovery(sessionId).catch((error: unknown) => {
            this.warn(sessionId, error)
          })
        )
        if (!resolved) {
          return 'retire'
        }
        share.leaseSettled = true
      }
      if (!this.context.sessions.has(sessionId) && !worker.loaded) {
        const stop = await this.load(sessionId, worker)
        if (stop) {
          return stop
        }
      }
      return await this.context.serialize(sessionId, () => this.runPass(sessionId, worker))
    } catch (error) {
      this.warn(sessionId, error)
      return 'failed'
    }
  }

  /** The pass, inside the chat's lane, on the conversation a reader holds or the worker's own. */
  private async runPass(sessionId: string, worker: ChatWorker): Promise<Outcome> {
    if (this.disposed) {
      return 'retire'
    }
    const session = this.sessionFor(sessionId, worker)
    // Closed, or written by another handle, since this attempt began: the next one reads it again.
    if (!session) {
      return 'again'
    }
    const pass = await runStructuredAgentSessionReconciliationPass(
      this.context,
      sessionId,
      session,
      worker.debts
    )
    if (pass.failed.length > 0) {
      this.warn(sessionId, pass.failed[0])
      return 'failed'
    }
    return pass.wrote ? 'again' : 'done'
  }

  private sessionFor(
    sessionId: string,
    worker: ChatWorker
  ): Pick<StructuredAgentSessionHostSession, 'journal' | 'lastEndedChild'> | undefined {
    const open = this.context.sessions.get(sessionId)
    if (open) {
      this.dropLoaded(worker)
      return open
    }
    const { loaded } = worker
    if (
      loaded &&
      !structuredAgentSessionJournalIsCurrent(this.context.deps, sessionId, loaded.journal)
    ) {
      this.dropLoaded(worker)
      return undefined
    }
    return loaded
  }

  /** Replays the journal in a background slot as the worker's own read; null to go on to the pass,
   *  else how the attempt ends. */
  private async load(sessionId: string, worker: ChatWorker): Promise<Outcome | null> {
    const result = await this.slots.run(worker, () =>
      loadStructuredAgentSessionForReconciliation(
        this.context.deps,
        sessionId,
        () => this.disposed || this.context.sessions.has(sessionId)
      )
    )
    const loaded = result?.value
    if (!loaded || this.disposed) {
      if (loaded?.kind === 'loaded') {
        void loaded.session.journal.close()
      }
      return 'retire'
    }
    if (loaded.kind === 'loaded') {
      worker.loaded = loaded.session
    }
    // Skipped: a reader opened it meanwhile, and the pass uses their conversation.
    return loaded.kind === 'nothing' ? 'retire' : null
  }

  private dropLoaded(worker: ChatWorker): void {
    const journal = worker.loaded?.journal
    worker.loaded = undefined
    void journal?.close()
  }

  private warn(sessionId: string, error: unknown): void {
    this.context.deps.logger.warn("settling a gone agent's leftover work did not finish", {
      scope: 'reconciliation',
      sessionId,
      error
    })
  }

  private afterAttempt(sessionId: string, worker: ChatWorker, outcome: Outcome): void {
    worker.running = false
    const attempted = worker.attempted.splice(0)
    attempted.forEach((resolve) => resolve())
    if (this.workers.get(sessionId) !== worker || this.disposed) {
      // Retired while this attempt ran: its own read closes now that nothing writes through it.
      this.dropLoaded(worker)
      return
    }
    if (outcome === 'failed') {
      worker.failures += 1
      if (worker.failures >= RECONCILIATION_MAX_FAILED_ATTEMPTS) {
        this.context.deps.logger.warn("gave up settling a gone agent's leftover work for now", {
          scope: 'reconciliation',
          sessionId,
          error: new Error(`${worker.failures} attempts failed`)
        })
        this.retire(sessionId, worker)
        return
      }
      const delay = Math.min(
        RECONCILIATION_BACKOFF_MS.max,
        RECONCILIATION_BACKOFF_MS.first * 2 ** (worker.failures - 1)
      )
      this.schedule(sessionId, worker, delay)
      return
    }
    worker.failures = 0
    if (outcome === 'again' || (outcome === 'done' && worker.dirty)) {
      this.schedule(sessionId, worker, 0)
      return
    }
    this.retire(sessionId, worker)
  }

  private schedule(sessionId: string, worker: ChatWorker, delay: number): void {
    if (delay === 0) {
      worker.timer = 'soon'
      queueMicrotask(() => this.attempt(sessionId))
      return
    }
    const timer = setTimeout(() => this.attempt(sessionId), delay)
    // A backoff alone never keeps the process alive.
    timer.unref?.()
    worker.timer = timer
  }

  private retire(sessionId: string, worker: ChatWorker): void {
    if (worker.timer && worker.timer !== 'soon') {
      clearTimeout(worker.timer)
    }
    worker.timer = null
    this.workers.delete(sessionId)
    if (!worker.running) {
      this.dropLoaded(worker)
      worker.attempted.splice(0).forEach((resolve) => resolve())
    }
  }
}
