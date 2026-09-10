// Where a provider's name for a conversation becomes the structured chat's label.
//
// Providers PUSH: Codex reports the thread's name when it opens one and again on
// every rename or clear, and Claude's name is read out of its transcript once a
// session is live. Nothing polls, so the name has one path in and one way out —
// the durable record.
//
// The record is also where "we already asked" lives. Both providers rebuild their
// session object on every acquisition, so an in-memory flag would re-ask after
// every eviction: re-imposing a name the user cleared, and paying for it again.
//
// Nothing here may fail an attach or a turn: the name is display metadata, so a
// write that loses a race with a close is logged and dropped, never retried.

import { normalizeAgentSessionConversationName } from '../../../shared/agent-session-conversation-name'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type StructuredAgentSessionNamingState = {
  conversationName: string | null
  namingAttempted: boolean
}

export type StructuredAgentSessionConversationNameDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'applyConversationNaming'>
  now: () => number
  onChanged: (sessionId: string, conversationName: string | null) => void
  /** Diagnostics only. Naming never surfaces to the user, but a host whose
   *  app-server refuses to name threads must not be indistinguishable from a
   *  model that simply declined. */
  onError?: (scope: string, error: unknown) => void
}

export class StructuredAgentSessionConversationNames {
  constructor(private readonly deps: StructuredAgentSessionConversationNameDeps) {}

  /** What a provider needs to know before deciding whether to ask for a name. */
  read = (sessionId: string): StructuredAgentSessionNamingState => {
    const record = this.deps.store.getRecord(sessionId)
    return {
      conversationName: record?.conversationName ?? null,
      namingAttempted: record?.conversationNamingAttempted === true
    }
  }

  /** Records a name a provider published, or clears it when the provider says so. */
  publish = async (sessionId: string, reported: unknown): Promise<void> => {
    const conversationName = normalizeAgentSessionConversationName(reported)
    if (!conversationName) {
      return
    }
    await this.apply(sessionId, { conversationName }, conversationName)
  }

  /**
   * The provider reports this conversation has no name any more.
   *
   * Also marks it attempted: a person who deletes the name has said what they
   * want it called, and the next message must not silently generate a new one.
   * That is the promise the durable marker already makes.
   */
  clear = async (sessionId: string): Promise<void> => {
    const state = this.read(sessionId)
    if (state.conversationName === null && state.namingAttempted) {
      return
    }
    await this.apply(sessionId, { conversationName: null, attempted: true }, null)
  }

  /** Durably marks that a naming attempt happened, so no later session repeats it. */
  markAttempted = async (sessionId: string): Promise<void> => {
    if (this.read(sessionId).namingAttempted) {
      return
    }
    try {
      await this.deps.store.applyConversationNaming(sessionId, { attempted: true }, this.deps.now())
    } catch (error) {
      this.deps.onError?.('mark-attempted', error)
    }
  }

  private apply = async (
    sessionId: string,
    change: { conversationName: string | null; attempted?: true },
    next: string | null
  ): Promise<void> => {
    // Read first so an unchanged name costs no durable transaction and no fan-out.
    const current = this.read(sessionId)
    if (current.conversationName === next && (!change.attempted || current.namingAttempted)) {
      return
    }
    try {
      await this.deps.store.applyConversationNaming(sessionId, change, this.deps.now())
    } catch (error) {
      this.deps.onError?.('apply-name', error)
      return
    }
    this.deps.onChanged(sessionId, next)
  }
}
