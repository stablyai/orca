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

/**
 * Chats opened as kept while their run's daemon start couldn't say whether it still runs. Only that
 * start's word, or its daemon and agent proven gone, settles one. The open's boundary lives on its
 * session, so a closed chat keeps nothing. One backoff retry per daemon start asks again while any
 * open chat waits on it; a send asks at once through the gate.
 */
export class StructuredAgentSessionKeptOpens {
  private readonly opened = new WeakMap<StructuredAgentSessionHostSession, number>()
  private readonly retries = new Map<string, { timer: NodeJS.Timeout; delayMs: number }>()

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
    if (!providerRelayRunUnknown(sessionId)) {
      return
    }
    this.opened.set(session, session.journal.cursor().sequence + 1)
    const instance = this.instanceOf(sessionId)
    if (instance) {
      this.retryLater(instance, RETRY_FIRST_MS)
    }
  }

  dispose(): void {
    for (const { timer } of this.retries.values()) {
      clearTimeout(timer)
    }
    this.retries.clear()
    installProviderRelayRunGate(null)
  }

  private instanceOf(sessionId: string): string | null {
    const record = this.input.record(sessionId)
    const placement = record ? agentSessionRunPlacement(record) : null
    return placement?.kind === 'relayed' ? placement.daemon.instance : null
  }

  private retryLater(instance: string, delayMs: number): void {
    if (this.retries.has(instance)) {
      return
    }
    const timer = setTimeout(() => {
      this.retries.delete(instance)
      void this.retry(instance, delayMs).catch((error: unknown) => this.warn(instance, error))
    }, delayMs)
    timer.unref?.()
    this.retries.set(instance, { timer, delayMs })
  }

  /** Asks again for each open chat still waiting on this daemon start; backs off while any is. */
  private async retry(instance: string, delayMs: number): Promise<void> {
    const waiting = [...this.input.sessions].filter(
      ([id, session]) => this.opened.has(session) && this.instanceOf(id) === instance
    )
    const verdicts = await Promise.all(
      waiting.map(async ([id]) => {
        const record = this.input.record(id)
        const verdict = record ? await providerRelayRunLiveness(record, { fresh: true }) : 'gone'
        if (verdict === 'gone') {
          await this.settleSerialized(id)
        } else if (verdict === 'kept') {
          this.release(id)
        }
        return verdict
      })
    )
    if (verdicts.includes('unknown')) {
      this.retryLater(instance, Math.min(delayMs * 2, RETRY_MAX_MS))
    }
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
