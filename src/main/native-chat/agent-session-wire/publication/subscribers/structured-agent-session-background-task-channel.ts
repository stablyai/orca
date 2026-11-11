import { readForkMarker } from '../history/agent-session-fork-marker'
import { structuredAgentSessionOwnerStatus } from '../../host/structured-agent-session-owner-status'
import type { AgentSessionCurrentRequestsRead } from '../../../../../shared/agent-session/requests/agent-session-current-requests-wire'
import { readCurrentRequestsPiece } from '../../observations/agent-session-current-requests'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionWorkState } from '../../../../../shared/agent-session/agent-session-work-state'
import { AgentSessionRefusalError } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { AGENT_SESSION_NOT_ATTACHED } from '../../operations/structured-agent-session-mutation-refusals'
import type { AgentSessionBackgroundTaskState } from '../../../../../shared/agent-session/agent-session-background-task-wire'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { structuredChildWorkLegacyTasks } from '../../../../../shared/agent-session/structured-agent-session-child-work-legacy'
import { structuredRunningChildWork } from '../../../../../shared/agent-status/child-work/agent-child-work-listing'
import { readStructuredAgentSessionHistoryResult } from '../history/structured-agent-session-history-result'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { AgentSessionHistoryScope } from '../history/agent-session-history-page'
import type { HistoryReader } from '../history/agent-session-history-page-bounds'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type { AgentSessionSubscribeInput } from './agent-session-subscribe-input'
import type { StructuredAgentSessionConversations } from '../../host/structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../../host/structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from '../../host/structured-agent-session-provider-child'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../history/agent-session-history-page-bounds'

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
    private readonly currentWork: StructuredAgentSessionClientDelivery['readCurrentWork'],
    private readonly readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined,
    private readonly childWorkIncomplete: (sessionId: string) => boolean = () => false
  ) {}

  handoffStatus = (sessionId: string) => structuredAgentSessionOwnerStatus(this.deps, sessionId)

  forkBoundary = async (
    sessionId: string,
    itemId: string,
    inheritedAnchor: string | undefined,
    compareSubmissions: boolean
  ) =>
    (await this.conversation(sessionId)).journal.reads.forkBoundary(
      itemId,
      inheritedAnchor,
      compareSubmissions
    )

  savedContent = async (sessionId: string) =>
    (await this.conversation(sessionId)).journal.reads.savedContent()

  historyItem = async (sessionId: string, itemId: string) =>
    (await this.conversation(sessionId)).journal.reads.itemDetail(itemId)

  conversationOutline = async (sessionId: string) =>
    (await this.conversation(sessionId)).journal.reads.conversationOutline(
      HISTORY_PAGE_CONTENT_BUDGET_BYTES
    )

  async history(
    request: AgentSessionHistoryRequest,
    scope?: AgentSessionHistoryScope,
    reader?: HistoryReader,
    replaceNormalizedHistory = true
  ): Promise<AgentSessionHistoryResult> {
    const journal = (await this.conversation(request.sessionId)).journal
    const [result, queue] = await Promise.all([
      this.currentWork(request.sessionId).then((work) =>
        readStructuredAgentSessionHistoryResult({
          journal,
          record: this.deps.store.getConversation(request.sessionId),
          forkMarker: readForkMarker(this.deps.store, request.sessionId),
          request,
          scope,
          reader,
          replaceNormalizedHistory,
          ...(work ? { work } : {})
        })
      ),
      this.subscribers.readQueuePublication(request.sessionId)
    ])
    const backgroundTasks = this.read(request.sessionId)
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

  /** What a waiter decides from, from the sources history pages state, without building a page. */
  async workState(sessionId: string): Promise<AgentSessionWorkState> {
    await this.conversation(sessionId)
    const work = await this.currentWork(sessionId)
    if (!work) {
      throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
    }
    const queue = await this.subscribers.readQueuePublication(sessionId)
    const fence = this.deps.store.getConversation(sessionId)?.currentFence
    return {
      working: work.working(),
      actionablePrompt: work.hasActionablePrompt(),
      ...(queue !== undefined
        ? {
            queuedMessageIds: (queue.queuedMessages ?? []).map((card) => card.messageId),
            nextQueuedMessageId: queue.nextQueuedMessageId
          }
        : {}),
      ...(fence !== undefined ? { fence } : {})
    }
  }

  async currentRequests(request: AgentSessionCurrentRequestsRead) {
    await this.conversation(request.sessionId)
    const work = await this.currentWork(request.sessionId)
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
