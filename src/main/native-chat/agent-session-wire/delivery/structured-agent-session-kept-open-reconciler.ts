import {
  installProviderRelayRunGate,
  providerRelayRunLiveness,
  providerRelayRunUnknown,
  type ProviderRelayRunRecord
} from '../../../provider-relay/app-provider-relays'
import { watchProviderRelayInstance } from '../../../provider-relay/provider-relay-instance-signals'
import { agentSessionRunPlacement } from '../../../../shared/agent-session/lifecycle/agent-session-run-placement'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'

export type StructuredAgentSessionKeptOpensInput = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  trackStart: <T>(start: Promise<T>) => Promise<T>
  record: (sessionId: string) => ProviderRelayRunRecord | null
  fence: (sessionId: string) => number | undefined
  /** Settles the gone last run and the open recovery it skipped, from the open's own boundary. */
  settle: (
    sessionId: string,
    open: StructuredAgentSessionHostSession,
    fence: number,
    openedSince: number
  ) => Promise<void>
  logger: Pick<StructuredAgentSessionLogger, 'warn'>
}

const RETRY_FIRST_MS = 2_000
/** Brennan 11-26 (option C): the backoff ceiling, with no cap while an open chat waits. */
const RETRY_MAX_MS = 5 * 60_000

/** One daemon start's open waiting chats and its retry: due, or running. */
type InstanceRetry = {
  chats: Set<string>
  /** When its next ask is due; null while one runs. */
  dueAt: number | null
  attempt: number
  lastStartedAt: number
  /** Its start said hello again while an ask ran: ask once more when that one ends. */
  woken: boolean
  unwatch: () => void
}

/**
 * Chats opened as kept while their run's daemon start couldn't say whether it still runs. Only that
 * start's word, or its daemon and agent proven gone, settles one. The open's boundary lives on its
 * session. Each daemon start asks again for its own waiting chats only: at once when that start
 * says hello again (never within 2 s of its last ask), otherwise backing off from 2 s to one 5 min
 * cadence all starts share, for as long as one of its chats stays open and waiting. One shared timer
 * serves every start, and none exists once no chat waits. A send asks at once through the gate, however long it waited.
 */
export class StructuredAgentSessionKeptOpens {
  private readonly opened = new WeakMap<StructuredAgentSessionHostSession, number>()
  private readonly retries = new Map<string, InstanceRetry>()
  /** Which start each waiting chat waits on, so a close reaches its retry at once. */
  private readonly waitingOn = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private timerDueAt = Number.POSITIVE_INFINITY
  private readonly cadenceFrom = Date.now()
  private disposed = false

  constructor(private readonly input: StructuredAgentSessionKeptOpensInput) {
    // A start asks fresh; a gone run the host held settles inside that start, before it spawns.
    installProviderRelayRunGate(async (chatKey) => {
      const record = input.record(chatKey)
      if (!record) {
        return 'gone'
      }
      const verdict = await providerRelayRunLiveness(record, { fresh: true })
      if (verdict === 'gone') {
        await this.settleNow(chatKey)
      } else if (verdict === 'kept') {
        this.release(chatKey)
      }
      return verdict
    })
  }

  adopted(sessionId: string, session: StructuredAgentSessionHostSession): void {
    const instance = providerRelayRunUnknown(sessionId) ? this.instanceOf(sessionId) : null
    if (!instance || this.disposed) {
      return
    }
    this.opened.set(session, session.journal.cursor().sequence + 1)
    let retry = this.retries.get(instance)
    if (!retry) {
      const created: InstanceRetry = {
        chats: new Set<string>(),
        dueAt: Date.now() + RETRY_FIRST_MS,
        attempt: 1,
        lastStartedAt: 0,
        woken: false,
        unwatch: () => {}
      }
      created.unwatch = watchProviderRelayInstance(instance, () => this.wake(instance, created))
      retry = created
      this.retries.set(instance, retry)
    }
    // A new waiter joins its start's retry; it never restarts the backoff.
    retry.chats.add(sessionId)
    this.waitingOn.set(sessionId, instance)
    this.arm(retry.dueAt)
  }

  /** The chat closed or was decided: it waits on nothing, and a start nobody waits on stops asking. */
  closed(sessionId: string): void {
    const instance = this.waitingOn.get(sessionId)
    this.waitingOn.delete(sessionId)
    const retry = instance ? this.retries.get(instance) : undefined
    if (!instance || !retry) {
      return
    }
    retry.chats.delete(sessionId)
    if (retry.chats.size === 0 && retry.dueAt !== null) {
      this.end(instance, retry)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const retry of this.retries.values()) {
      retry.unwatch()
    }
    this.retries.clear()
    this.waitingOn.clear()
    this.disarm()
    installProviderRelayRunGate(null)
  }

  private instanceOf(sessionId: string): string | null {
    const record = this.input.record(sessionId)
    const placement = record ? agentSessionRunPlacement(record) : null
    return placement?.kind === 'relayed' ? placement.daemon.instance : null
  }

  /** Its start said hello again: ask now, never sooner than 2 s after its last ask began. */
  private wake(instance: string, retry: InstanceRetry): void {
    if (this.disposed || this.retries.get(instance) !== retry) {
      return
    }
    if (retry.dueAt === null) {
      retry.woken = true
      return
    }
    retry.dueAt = Math.min(retry.dueAt, retry.lastStartedAt + RETRY_FIRST_MS)
    this.arm(retry.dueAt)
  }

  /**
   * The one timer, moved earlier when a start falls due sooner; one that comes due with nothing to
   * do finds the next due time in the same pass. None while no start waits.
   */
  private arm(dueAt: number | null): void {
    if (dueAt === null || dueAt >= this.timerDueAt || this.disposed) {
      return
    }
    this.disarm()
    this.timerDueAt = dueAt
    this.timer = setTimeout(() => this.tick(), Math.max(0, dueAt - Date.now()))
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.timerDueAt = Number.POSITIVE_INFINITY
  }

  private tick(): void {
    this.timer = null
    this.timerDueAt = Number.POSITIVE_INFINITY
    const now = Date.now()
    let next: number | null = null
    for (const [instance, retry] of this.retries) {
      if (retry.dueAt === null) {
        continue
      }
      if (retry.dueAt > now) {
        next = next === null ? retry.dueAt : Math.min(next, retry.dueAt)
        continue
      }
      retry.dueAt = null
      retry.lastStartedAt = now
      void this.retry(retry)
        .catch((error: unknown) => this.warn(instance, error))
        .finally(() => this.reschedule(instance, retry))
    }
    this.arm(next)
  }

  private reschedule(instance: string, retry: InstanceRetry): void {
    if (this.disposed || this.retries.get(instance) !== retry) {
      return
    }
    if (retry.chats.size === 0) {
      this.end(instance, retry)
      return
    }
    if (retry.woken) {
      retry.woken = false
      retry.dueAt = retry.lastStartedAt + RETRY_FIRST_MS
    } else {
      retry.attempt += 1
      const backoffMs = RETRY_FIRST_MS * 2 ** (retry.attempt - 1)
      retry.dueAt = backoffMs < RETRY_MAX_MS ? Date.now() + backoffMs : this.nextCeilingTick()
    }
    this.arm(retry.dueAt)
  }

  /**
   * Starts backed off to the ceiling share one 5 min cadence, so their wakeups don't multiply with
   * how many there are or when each last finished.
   */
  private nextCeilingTick(): number {
    const after = Date.now() + RETRY_FIRST_MS
    return this.cadenceFrom + Math.ceil((after - this.cadenceFrom) / RETRY_MAX_MS) * RETRY_MAX_MS
  }

  private end(instance: string, retry: InstanceRetry): void {
    retry.unwatch()
    for (const id of retry.chats) {
      this.waitingOn.delete(id)
    }
    this.retries.delete(instance)
    if (this.retries.size === 0) {
      this.disarm()
    }
  }

  /** Asks again for this daemon start's open waiting chats; closed or decided ones leave the set. */
  private async retry(retry: InstanceRetry): Promise<void> {
    await Promise.allSettled(
      [...retry.chats].map(async (id) => {
        const session = this.input.sessions.get(id)
        const record = this.input.record(id)
        if (!session || !this.opened.has(session) || !record) {
          retry.chats.delete(id)
          this.waitingOn.delete(id)
          return
        }
        const verdict = await providerRelayRunLiveness(record, { fresh: true })
        if (verdict === 'gone') {
          await this.settleSerialized(id)
        } else if (verdict === 'kept') {
          this.release(id)
        }
        if (verdict !== 'unknown') {
          retry.chats.delete(id)
          this.waitingOn.delete(id)
        }
      })
    )
  }

  private release(sessionId: string): void {
    const session = this.input.sessions.get(sessionId)
    if (session) {
      this.opened.delete(session)
    }
    this.closed(sessionId)
  }

  /** Quit waits only for the settle itself, never for a daemon. */
  private settleSerialized(sessionId: string): Promise<void> {
    return this.input.trackStart(this.input.serialize(sessionId, () => this.settleNow(sessionId)))
  }

  private async settleNow(sessionId: string): Promise<void> {
    const open = this.input.sessions.get(sessionId)
    const since = open ? this.opened.get(open) : undefined
    if (!open || since === undefined) {
      return
    }
    // Writes go at the journal's current fence; a failed settle keeps its entry for a later try.
    const fence = this.input.fence(sessionId)
    if (!open.child && fence !== undefined) {
      await this.input.settle(sessionId, open, fence, since)
    }
    this.opened.delete(open)
    this.closed(sessionId)
  }

  private warn(scopeId: string, error: unknown): void {
    this.input.logger.warn('settling a chat whose agent turned out not kept failed', {
      scope: 'kept-open-reconcile',
      sessionId: scopeId,
      error
    })
  }
}
