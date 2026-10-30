import type { AgentSessionCurrentRequestsRead } from '../../../shared/agent-session-current-requests-wire'
import { readCurrentRequestsPiece } from './agent-session-current-requests'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredChildWorkLegacyTasks } from '../../../shared/structured-agent-session-child-work-legacy'
import { structuredRunningChildWork } from '../../../shared/agent-child-work-listing'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import type { AgentSessionHistoryScope } from './agent-session-history-page'
import type {
  AgentSessionSubscribers,
  AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** Derive modern/legacy rosters from child records; null hides the strip only when no known/unlisted work remains. */
export class StructuredAgentSessionBackgroundTaskChannel {
  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: StructuredAgentSessionConversations,
    private readonly subscribers: AgentSessionSubscribers,
    /** Open at rest without starting an agent. */
    private readonly conversation: (
      sessionId: string
    ) => Promise<StructuredAgentSessionHostSession>,
    private readonly readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined,
    private readonly childWorkIncomplete: (sessionId: string) => boolean = () => false
  ) {}

  async history(
    request: AgentSessionHistoryRequest,
    scope?: AgentSessionHistoryScope,
    replaceNormalizedHistory = true
  ): Promise<AgentSessionHistoryResult> {
    const journal = (await this.conversation(request.sessionId)).journal
    const work = hostStructuredAgentSessionCurrentWork(
      { store: this.deps.store, sessions: this.sessions },
      request.sessionId
    )
    const result = readStructuredAgentSessionHistoryResult({
      journal,
      record: this.deps.store.getConversation(request.sessionId),
      request,
      scope,
      replaceNormalizedHistory,
      ...(work ? { work } : {})
    })
    const backgroundTasks = this.read(request.sessionId)
    const queue = this.subscribers.readQueuePublication(request.sessionId)
    const hostNow = this.deps.now?.() ?? Date.now()
    return {
      ...result,
      page: {
        ...result.page,
        hostNow,
        // Client reducers give live state precedence over stale history replies.
        ...(queue !== undefined
          ? {
              queuedMessages: queue.queuedMessages,
              queuePause: queue.queuePause,
              nextQueuedMessageId: queue.nextQueuedMessageId
            }
          : {}),
        backgroundTasks
      }
    }
  }

  async currentRequests(request: AgentSessionCurrentRequestsRead) {
    await this.conversation(request.sessionId)
    const work = hostStructuredAgentSessionCurrentWork(
      { store: this.deps.store, sessions: this.sessions },
      request.sessionId
    )
    if (!work) {
      throw new Error('Current requests unavailable')
    }
    return readCurrentRequestsPiece(work.requestProjection(request.sessionId), request)
  }

  async subscribe(input: AgentSessionSubscribeInput): Promise<() => void> {
    const session = await this.conversation(input.sessionId)
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence: structuredAgentSessionConversationFence(this.deps.store, input.sessionId)
    })
  }

  publish(sessionId: string): void {
    if (this.sessions.get(sessionId)) {
      this.subscribers.republishBackgroundTasks(
        sessionId,
        structuredAgentSessionConversationFence(this.deps.store, sessionId)
      )
    }
  }

  /** Child records define the roster even after the provider releases the session. */
  read(sessionId: string): AgentSessionBackgroundTaskState | null {
    const session = this.sessions.get(sessionId)
    const views = structuredRunningChildWork((session && this.readChildWork(sessionId)) ?? [])
    // Untracked work still needs a visible Stop.
    const incomplete = this.childWorkIncomplete(sessionId)
    if (!session || (views.length === 0 && !incomplete)) {
      return null
    }
    const stops = this.deps.adapter.backgroundTaskStops?.(sessionId)
    const { tasks, settledTasks } = structuredChildWorkLegacyTasks(views, session.params.provider)
    return {
      state: 'monitoring',
      ...(tasks ? { tasks } : {}),
      ...(settledTasks ? { settledTasks } : {}),
      ...(stops?.supportsTaskStop ? { supportsTaskStop: true } : {}),
      ...(stops?.supportsStopAll ? {} : { supportsStopAll: false }),
      children: views,
      ...(incomplete ? { incomplete: true } : {})
    }
  }
}
