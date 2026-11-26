import {
  installProviderRelayKeptUnverifiedProof,
  providerRelayInventoryCompleted,
  providerRelayKeptFromLastRun,
  providerRelayKeptUnverified,
  providerRelayListingSettled
} from '../../../provider-relay/app-provider-relays'
import { ownerProvenGone } from '../host/structured-agent-session-kept-at-open'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'

export type StructuredAgentSessionKeptOpensInput = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  trackStart: <T>(start: Promise<T>) => Promise<T>
  owner: (sessionId: string) => AgentSessionProcessIdentity | null
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

/** The gone run as the open saw it: a send reserves the next run, clearing its owner and fence. */
type KeptOpen = {
  since: number
  owner: AgentSessionProcessIdentity | null
  fence: number | undefined
}

/**
 * Chats opened as kept while the relay listing was late. Only proof settles one: a complete listing
 * without its agent, or its owner proven gone. What the open saw lives on its session, so a closed
 * chat keeps nothing; one subscription waits for the inventory, then settles whichever are open.
 */
export class StructuredAgentSessionKeptOpens {
  private readonly opened = new WeakMap<StructuredAgentSessionHostSession, KeptOpen>()
  private waiting = false

  constructor(private readonly input: StructuredAgentSessionKeptOpensInput) {
    // A send to a chat no listing has placed: an owner proven gone since settles it inside that start.
    installProviderRelayKeptUnverifiedProof(async (chatKey) => {
      const owner = this.keptOpen(chatKey)?.owner
      if (!owner || !(await ownerProvenGone(owner))) {
        return false
      }
      await this.settleNow(chatKey)
      return true
    })
  }

  adopted(sessionId: string, session: StructuredAgentSessionHostSession): void {
    if (!providerRelayKeptUnverified(sessionId)) {
      return
    }
    this.opened.set(session, {
      since: session.journal.cursor().sequence + 1,
      owner: this.input.owner(sessionId),
      fence: this.input.fence(sessionId)
    })
    void this.reconcile(sessionId).catch((error: unknown) => this.warn(sessionId, error))
  }

  dispose(): void {
    installProviderRelayKeptUnverifiedProof(null)
  }

  private keptOpen(sessionId: string): KeptOpen | undefined {
    const session = this.input.sessions.get(sessionId)
    return session ? this.opened.get(session) : undefined
  }

  private async reconcile(sessionId: string): Promise<void> {
    if (await providerRelayListingSettled()) {
      return this.settleIfNotKept(sessionId)
    }
    const owner = this.keptOpen(sessionId)?.owner
    if (owner && (await ownerProvenGone(owner))) {
      return this.settleSerialized(sessionId)
    }
    if (!this.waiting) {
      this.waiting = true
      void providerRelayInventoryCompleted().then(() => {
        for (const [id, session] of this.input.sessions) {
          if (this.opened.has(session)) {
            void this.settleIfNotKept(id).catch((error: unknown) => this.warn(id, error))
          }
        }
      })
    }
  }

  private settleIfNotKept(sessionId: string): Promise<void> {
    if (providerRelayKeptUnverified(sessionId) && !providerRelayKeptFromLastRun(sessionId)) {
      return this.settleSerialized(sessionId)
    }
    const session = this.input.sessions.get(sessionId)
    if (session) {
      this.opened.delete(session)
    }
    return Promise.resolve()
  }

  /** Quit waits only for the settle itself, never for a listing. */
  private settleSerialized(sessionId: string): Promise<void> {
    return this.input.trackStart(this.input.serialize(sessionId, () => this.settleNow(sessionId)))
  }

  private async settleNow(sessionId: string): Promise<void> {
    const open = this.input.sessions.get(sessionId)
    const kept = open ? this.opened.get(open) : undefined
    if (!open || !kept) {
      return
    }
    this.opened.delete(open)
    if (!open.child && kept.fence !== undefined) {
      await this.input.settle(sessionId, open, kept.fence, kept.since)
    }
  }

  private warn(sessionId: string, error: unknown): void {
    this.input.logger.warn('settling a chat whose agent turned out not kept failed', {
      scope: 'kept-open-reconcile',
      sessionId,
      error
    })
  }
}
