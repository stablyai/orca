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

/**
 * Chats opened as kept while the relay listing was late. Only proof settles one: a complete listing
 * without its agent, or its owner proven gone. Nothing per chat outlives its close but its open's
 * boundary; one subscription waits for the inventory, then settles whichever of them is open.
 */
export class StructuredAgentSessionKeptOpens {
  private readonly openedSince = new Map<string, number>()
  private waiting = false

  constructor(private readonly input: StructuredAgentSessionKeptOpensInput) {
    // A send to a chat no listing has placed: an owner proven gone since settles it inside that start.
    installProviderRelayKeptUnverifiedProof(async (chatKey) => {
      const owner = input.owner(chatKey)
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
    this.openedSince.set(sessionId, session.journal.cursor().sequence + 1)
    void this.reconcile(sessionId).catch((error: unknown) => this.warn(sessionId, error))
  }

  dispose(): void {
    this.openedSince.clear()
    installProviderRelayKeptUnverifiedProof(null)
  }

  private async reconcile(sessionId: string): Promise<void> {
    if (await providerRelayListingSettled()) {
      return this.settleIfNotKept(sessionId)
    }
    const owner = this.input.owner(sessionId)
    if (owner && (await ownerProvenGone(owner))) {
      return this.settleSerialized(sessionId)
    }
    if (!this.waiting) {
      this.waiting = true
      void providerRelayInventoryCompleted().then(() => {
        for (const id of this.openedSince.keys()) {
          if (this.input.sessions.has(id)) {
            void this.settleIfNotKept(id).catch((error: unknown) => this.warn(id, error))
          } else {
            this.openedSince.delete(id)
          }
        }
      })
    }
  }

  private settleIfNotKept(sessionId: string): Promise<void> {
    return providerRelayKeptUnverified(sessionId) && !providerRelayKeptFromLastRun(sessionId)
      ? this.settleSerialized(sessionId)
      : Promise.resolve()
  }

  /** Quit waits only for the settle itself, never for a listing. */
  private settleSerialized(sessionId: string): Promise<void> {
    return this.input.trackStart(this.input.serialize(sessionId, () => this.settleNow(sessionId)))
  }

  private async settleNow(sessionId: string): Promise<void> {
    const open = this.input.sessions.get(sessionId)
    const fence = this.input.fence(sessionId)
    const since = this.openedSince.get(sessionId)
    this.openedSince.delete(sessionId)
    if (open && !open.child && fence !== undefined && since !== undefined) {
      await this.input.settle(sessionId, open, fence, since)
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
