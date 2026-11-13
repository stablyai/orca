import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'
import {
  AGENT_JOURNAL_THREAD_GOAL_STATUSES,
  type AgentJournalThreadGoalState,
  type AgentJournalItemBody
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { spelledProviderTimelineItemKey } from '../../shared/provider-timeline-item-key'
import { journalPayload } from '../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import { traexRecord } from './traex-protocol'

const goalSchema = z.looseObject({
  objective: z.string(),
  status: z.enum(AGENT_JOURNAL_THREAD_GOAL_STATUSES),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})
const prefixes = {
  active: 'Goal set',
  paused: 'Goal paused',
  blocked: 'Goal blocked',
  complete: 'Goal complete',
  usageLimited: 'Goal stopped — usage limit',
  budgetLimited: 'Goal stopped — token budget spent'
}

function signature(state: AgentJournalThreadGoalState): string {
  return state.state === 'cleared'
    ? 'cleared'
    : JSON.stringify([state.goal.createdAt, state.goal.status, state.goal.objective])
}

export class TraexGoalTimeline {
  private last: { signature: string; key: string } | undefined
  constructor(
    private readonly deps: {
      threadId: string
      journal: () => StructuredAgentSessionTransitionJournal | null | undefined
      apply: (event: ProviderTimelineEvent) => void
    }
  ) {}

  observe(method: string, value: unknown): void {
    if (method !== 'thread/goal/updated' && method !== 'thread/goal/cleared') {
      return
    }
    const params = traexRecord(value)
    if (params.threadId !== this.deps.threadId) {
      return
    }
    const parsed = method === 'thread/goal/updated' ? goalSchema.safeParse(params.goal) : null
    if (parsed && !parsed.success) {
      this.deps.apply({
        type: 'provider.frame',
        frameKind: `notification:${method}`,
        payload: params,
        join: { thread: this.deps.threadId, scope: { kind: 'thread' } }
      })
      return
    }
    const state: AgentJournalThreadGoalState = parsed?.success
      ? {
          state: 'set',
          goal: {
            objective: parsed.data.objective,
            status: parsed.data.status,
            tokensUsed: parsed.data.tokensUsed,
            timeUsedSeconds: parsed.data.timeUsedSeconds,
            tokenBudget: parsed.data.tokenBudget ?? null,
            createdAt: parsed.data.createdAt * 1000,
            updatedAt: parsed.data.updatedAt * 1000
          }
        }
      : { state: 'cleared' }
    const current = signature(state)
    let latest: { id: string; sequence: number; state: AgentJournalThreadGoalState } | undefined
    this.deps.journal()?.visitItemsWithLinkage((id, sequence, body, linkage) => {
      if (
        body.kind === 'status' &&
        body.threadGoal &&
        isRootAgentJournalItem(linkage) &&
        (!latest || sequence > latest.sequence)
      ) {
        latest = { id, sequence, state: body.threadGoal }
      }
    })
    if (
      state.state === 'cleared' &&
      (this.last ? this.last.signature === 'cleared' : !latest || latest.state.state === 'cleared')
    ) {
      return
    }
    if (!this.last && latest && signature(latest.state) === current) {
      const identity = parseAgentJournalItemKey(latest.id)
      const part =
        identity?.provider === 'legacy' ? spelledProviderTimelineItemKey(identity.recordId) : null
      if (part && !part.includes('#')) {
        this.last = { signature: current, key: decodeURIComponent(part) }
      }
    }
    if (this.last?.signature !== current) {
      this.last = { signature: current, key: `goal:${randomUUID()}` }
    }
    const text =
      state.state === 'cleared'
        ? 'Goal cleared'
        : `${prefixes[state.goal.status]}: ${state.goal.objective}`
    const body: AgentJournalItemBody = {
      kind: 'status',
      text,
      threadGoal: state,
      providerFrame: {
        provider: 'trae',
        kind: `notification:${method}`,
        payload: journalPayload(JSON.stringify(params))
      }
    }
    this.deps.apply({
      type: 'item.update',
      item: this.last!.key,
      body,
      join: { thread: this.deps.threadId, scope: { kind: 'thread' } }
    })
  }
}
