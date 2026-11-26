import {
  installProviderRelayRunGate,
  providerRelayRunLiveness,
  providerRelayRunUnknown,
  type ProviderRelayRunRecord
} from '../../../provider-relay/app-provider-relays'
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
const RETRY_MAX_MS = 60_000
/** About four minutes of retries per daemon start; after that only a send asks again. */
const RETRY_ATTEMPTS = 8

/** One daemon start's open waiting chats and its single retry, scheduled or running. */
type InstanceRetry = {
  chats: Set<string>
  timer: NodeJS.Timeout | null
  running: boolean
  attempt: number
}

/**
 * Chats opened as kept while their run's daemon start couldn't say whether it still runs. Only that
 * start's word, or its daemon and agent proven gone, settles one. The open's boundary lives on its
 * session, so a closed chat keeps nothing past the next retry. One bounded backoff retry per daemon
 * start asks again for its own waiting chats only; a send asks at once through the gate, however
 * long it waited.
 */
export class StructuredAgentSessionKeptOpens {
  private readonly opened = new WeakMap<StructuredAgentSessionHostSession, number>()
  private readonly retries = new Map<string, InstanceRetry>()
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
    const retry = this.retries.get(instance) ?? {
      chats: new Set<string>(),
      timer: null,
      running: false,
      attempt: 0
    }
    this.retries.set(instance, retry)
    retry.chats.add(sessionId)
    // A new waiter joins the scheduled or running retry; it never restarts the backoff.
    if (!retry.timer && !retry.running) {
      this.schedule(instance, retry)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const retry of this.retries.values()) {
      if (retry.timer) {
        clearTimeout(retry.timer)
      }
    }
    this.retries.clear()
    installProviderRelayRunGate(null)
  }

  private instanceOf(sessionId: string): string | null {
    const record = this.input.record(sessionId)
    const placement = record ? agentSessionRunPlacement(record) : null
    return placement?.kind === 'relayed' ? placement.daemon.instance : null
  }

  private schedule(instance: string, retry: InstanceRetry): void {
    retry.attempt += 1
    if (this.disposed || retry.chats.size === 0 || retry.attempt > RETRY_ATTEMPTS) {
      this.retries.delete(instance)
      return
    }
    const delayMs = Math.min(RETRY_FIRST_MS * 2 ** (retry.attempt - 1), RETRY_MAX_MS)
    retry.timer = setTimeout(() => {
      retry.timer = null
      retry.running = true
      void this.retry(retry)
        .catch((error: unknown) => this.warn(instance, error))
        .finally(() => {
          retry.running = false
          this.schedule(instance, retry)
        })
    }, delayMs)
    retry.timer.unref?.()
  }

  /** Asks again for this daemon start's open waiting chats; closed or decided ones leave the set. */
  private async retry(retry: InstanceRetry): Promise<void> {
    await Promise.allSettled(
      [...retry.chats].map(async (id) => {
        const session = this.input.sessions.get(id)
        const record = this.input.record(id)
        if (!session || !this.opened.has(session) || !record) {
          retry.chats.delete(id)
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
        }
      })
    )
  }

  private release(sessionId: string): void {
    const session = this.input.sessions.get(sessionId)
    if (session) {
      this.opened.delete(session)
    }
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
  }

  private warn(scopeId: string, error: unknown): void {
    this.input.logger.warn('settling a chat whose agent turned out not kept failed', {
      scope: 'kept-open-reconcile',
      sessionId: scopeId,
      error
    })
  }
}
