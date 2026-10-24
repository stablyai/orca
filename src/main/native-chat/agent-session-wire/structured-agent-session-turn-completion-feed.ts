// Derive attention edges on the host so background chats work without a renderer reader.
// Completion and prompt events are live-only; late subscribers receive no replay.

import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../../shared/agent-session-attention'
import type { StructuredAgentSessionLatestRequest } from '../../../shared/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-feed'

export type StructuredAgentSessionTurnCompletionSubscriber = {
  id: string
  emit: (event: AgentSessionTurnCompletionEvent) => void
  /** Older clients misread prompt arms, so delivery requires opt-in. */
  includePrompts?: boolean
  /** In-process reconciliation on restore and prompt removal. */
  onState?: (state: StructuredAttentionState) => void
  onTurnStarted?: (sessionId: string, cursor: AgentJournalCursor, sourceSequence: number) => void
}

type CompletionFeedCursor = { epoch: string; sequence: number }

type CompletionFeedSession = {
  journal: Pick<AgentSessionJournal, 'cursor'> & Partial<Pick<AgentSessionJournal, 'snapshot'>>
  params: { location: AgentSessionRecord['location'] }
}

export type StructuredAgentSessionTurnCompletionFeedDeps = {
  sessions: ReadonlyMap<string, CompletionFeedSession>
  now: () => number
  /** Reuse this commit’s status projection so events identify the request shown in the row. */
  readStatusState: (
    sessionId: string,
    journal?: AgentSessionJournal
  ) => StructuredAgentSessionStatusState | null
}

type RequestMark = Pick<StructuredAgentSessionLatestRequest, 'kind' | 'id'>

/** Missing baseline makes first observation silent; settled/prompts track already-accounted edges. */
type SessionBaseline = CompletionFeedCursor & {
  rootId?: string
  sourceSequence: number
  settled: RequestMark | null
  prompts: ReadonlySet<string>
}

function settledMark(request: StructuredAgentSessionLatestRequest | null): RequestMark | null {
  return request && request.turnState !== 'running' ? { kind: request.kind, id: request.id } : null
}

export class StructuredAgentSessionTurnCompletionFeed {
  private readonly subscribers = new Map<string, StructuredAgentSessionTurnCompletionSubscriber>()
  private readonly baselines = new Map<string, SessionBaseline>()

  constructor(private readonly deps: StructuredAgentSessionTurnCompletionFeedDeps) {}

  subscribe(subscriber: StructuredAgentSessionTurnCompletionSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber)
    return () => this.unsubscribe(subscriber.id)
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  /** Reattachments baseline silently instead of announcing old work. */
  forget(sessionId: string): void {
    this.baselines.delete(sessionId)
  }

  /** When prompt and clean completion coincide, keep prompt identity; send completion only to legacy clients.
   * Failures reach everyone; first/historical observations and repeated identities stay silent. */
  observe(
    sessionId: string,
    journal?: AgentSessionJournal,
    options?: { historical?: boolean }
  ): void {
    const session = this.deps.sessions.get(sessionId)
    const state = session ? this.deps.readStatusState(sessionId, journal) : null
    if (!session || !state) {
      return
    }
    const cursor = (journal ?? session.journal).cursor()
    const request = state.latestRequest
    const prompts = new Set(state.pendingPromptIds)
    const baseline = this.baselines.get(sessionId)
    if (!baseline || options?.historical || [...baseline.prompts].some((id) => !prompts.has(id))) {
      this.publishState(session, sessionId, state.pendingPromptIds)
    }
    if (!baseline || options?.historical) {
      this.baselines.set(sessionId, {
        ...cursor,
        sourceSequence: cursor.sequence,
        settled: settledMark(request),
        prompts,
        rootId: request?.kind === 'turn' ? request.id : undefined
      })
      return
    }
    if (baseline.epoch !== cursor.epoch || cursor.sequence < baseline.sequence) {
      // Rewind/import changes identity without a provider edge; silently replace the baseline.
      baseline.epoch = cursor.epoch
      baseline.sequence = cursor.sequence
      baseline.sourceSequence = cursor.sequence
      baseline.rootId = request?.kind === 'turn' ? request.id : undefined
      baseline.settled = settledMark(request)
      baseline.prompts = prompts
      return
    }
    if (
      request?.kind === 'turn' &&
      request.turnState === 'running' &&
      baseline.rootId !== request.id
    ) {
      const root = (journal ?? session.journal)
        .snapshot?.()
        .items.find(
          (item) =>
            isRootAgentJournalItem(item) &&
            !item.recovered &&
            readAgentJournalTurn(item.body)?.turnId === request.id
        )
      if (root && root.sequence > baseline.sequence) {
        for (const subscriber of this.subscribers.values()) {
          try {
            subscriber.onTurnStarted?.(
              sessionId,
              { epoch: cursor.epoch, sequence: root.sequence },
              baseline.sourceSequence
            )
          } catch {
            /* Retirement cannot interrupt provider publication. */
          }
        }
      }
    }
    baseline.rootId = request?.kind === 'turn' ? request.id : undefined
    baseline.sequence = cursor.sequence
    const raised = state.pendingPromptIds.find((id) => !baseline.prompts.has(id))
    baseline.prompts = prompts
    const completion = this.settledCompletion(sessionId, session, state, baseline)
    if (completion) {
      completion.journalCursor = cursor
      const restatesPrompt = completion.awaitingUser === true && completion.outcome === 'success'
      this.broadcast({ type: 'completion', completion }, restatesPrompt ? 'legacy' : 'all')
      if (!restatesPrompt) {
        return
      }
    }
    if (raised === undefined) {
      return
    }
    this.broadcast(
      {
        type: 'prompt',
        prompt: {
          scope: session.params.location,
          sessionId,
          promptId: raised,
          journalCursor: cursor,
          raisedAt: this.deps.now()
        }
      },
      'prompt-aware'
    )
  }

  private publishState(
    session: CompletionFeedSession,
    sessionId: string,
    pendingPromptIds: readonly string[]
  ): void {
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.onState?.({ scope: session.params.location, sessionId, pendingPromptIds })
      } catch {
        // Delivery bookkeeping cannot cost this commit its attention edge.
      }
    }
  }

  private settledCompletion(
    sessionId: string,
    session: CompletionFeedSession,
    state: StructuredAgentSessionStatusState,
    baseline: SessionBaseline
  ): AgentSessionTurnCompletion | null {
    const request = state.latestRequest
    if (request?.turnState === 'running') {
      // Clear on running so each running-to-settled transition can fire, even for a reused ID.
      baseline.settled = null
      return null
    }
    // Wait until all owed sends are answered; pending prompts announce immediately.
    // Withdrawn sends expose the older request without making it news.
    if (
      state.owesWork ||
      !request ||
      (baseline.settled?.kind === request.kind && baseline.settled.id === request.id)
    ) {
      return null
    }
    baseline.settled = settledMark(request)
    // No outcome means unknown; inferring success would alert on failures.
    if (!request.outcome) {
      return null
    }
    return {
      scope: session.params.location,
      sessionId,
      turnId: request.id,
      outcome: request.outcome,
      completedAt: this.deps.now(),
      // Include attention here: remote clients receive status and completion streams unordered.
      ...(state.summary.status === 'attention' ? { awaitingUser: true as const } : {})
    }
  }

  private broadcast(
    event: AgentSessionAttentionEdge,
    audience: 'all' | 'legacy' | 'prompt-aware'
  ): void {
    for (const subscriber of this.subscribers.values()) {
      const promptAware = subscriber.includePrompts === true
      if ((audience === 'legacy' && promptAware) || (audience === 'prompt-aware' && !promptAware)) {
        continue
      }
      try {
        subscriber.emit(event)
      } catch {
        this.subscribers.delete(subscriber.id)
      }
    }
  }
}
