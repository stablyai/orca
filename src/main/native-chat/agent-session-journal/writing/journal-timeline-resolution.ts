import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { spelledProviderTimelineItemKey } from '../../../../shared/provider-timeline-item-key'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalMessageItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
export type JournalResolvedItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  turnScope?: AgentJournalTurnScope
}
import type { JournalTimelineView } from './journal-timeline-view'
import { requiresTerminalSettlement } from '../item-lifecycle/journal-terminal-settlement'
import { relightsProviderTimelineBackgroundTask } from '../../agent-session-timeline/provider-timeline-background-tasks'
import {
  resolveProviderTimelineRequestOpen,
  resolveProviderTimelineTurnOpen,
  resolveProviderTimelineTurnOpener,
  type ProviderTimelineRequest
} from '../../agent-session-timeline/provider-timeline-writer-resolution'
import {
  resolveAgentJournalTurnRowWrite,
  type AgentJournalTurnRowTarget,
  type AgentJournalTurnRowWrite
} from '../../agent-session-timeline/agent-journal-turn-row-revision'
import {
  mergeAgentJournalTurnFailure,
  refineAgentJournalQuotaTurnEnd,
  type AgentJournalFailureVoice
} from '../../agent-session-timeline/agent-journal-turn-failure-revision'
import { resolveClaudeBackgroundTaskIdentity } from '../../../claude/background-tasks/claude-background-task-identity'
import { isBackgroundTaskBlock } from '../../../../shared/native-chat/native-chat-types'
import { backgroundTaskJournalBody } from '../../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import {
  resolveCodexGoalIdentity,
  type CodexGoalRowChoice
} from '../../../codex/structured/journal/codex-goal-journal-identity'

type TimelineItemResolution =
  | {
      kind: 'text-snapshot'
      identity: AgentJournalItemIdentity
      body: AgentJournalMessageItem
    }
  | {
      kind: 'guarded-item'
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      change: 'open' | 'update' | 'close'
    }
  | { kind: 'literal'; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  | { kind: 'acp-loss-warning'; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  | {
      kind: 'request-open'
      request: ProviderTimelineRequest
      body: AgentJournalItemBody
      turnItemId: string | null
      outlivesTurn?: true
    }
  | { kind: 'turn-open'; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  | {
      kind: 'turn-opener'
      identity: AgentJournalItemIdentity
      message: { userItemId: string; requestedAt: number }
    }
  | { kind: 'turn-row'; target: AgentJournalTurnRowTarget; write: AgentJournalTurnRowWrite }
  /** Record the provider's turn on a still-running host command turn. */
  | { kind: 'turn-claim'; identity: AgentJournalItemIdentity; providerTurnId: string }
  | {
      kind: 'turn-failure'
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      voice: AgentJournalFailureVoice
    }
  /** A background-task row whose generation follows the task's saved incarnations. */
  | { kind: 'background-task'; taskId: string; toolUseId?: string; body: AgentJournalItemBody }
  /** A provider goal row whose identity follows the thread's newest saved goal row. */
  | { kind: 'thread-goal'; choice: CodexGoalRowChoice }
  | {
      kind: 'quota-turn-end'
      identity: AgentJournalItemIdentity
      failureItemId: string
      write: AgentJournalTurnRowWrite
    }
  /** A person's Stop at the write position picks one of a provider result's two readings. */
  | {
      kind: 'stop-decided'
      turnId: string
      endedAt: number
      ran: JournalTimelineItemResolution | null
      stopped: JournalTimelineItemResolution | null
    }

export type JournalTimelineItemResolution = TimelineItemResolution & {
  /** Related rows own placement even after the producer forgets their turn. */
  scopeItemIds?: readonly string[]
}

export type JournalTimelineItemResult = (
  | { kind: 'resolved'; item: JournalResolvedItem }
  | { kind: 'dropped'; reason: 'turn-settled'; turnItemId: string }
  | { kind: 'dropped'; reason: 'item-settled' }
  | { kind: 'dropped' }
) & { stopped?: true }

const nothing = { kind: 'dropped' } as const

function resolved(item: JournalResolvedItem | null): JournalTimelineItemResult {
  return item ? { kind: 'resolved', item } : nothing
}

/** The persisted scope wins over the placement captured when the stream was admitted. */
export function resolveJournalTimelineItem(
  view: JournalTimelineView,
  resolution: JournalTimelineItemResolution,
  placement: AgentJournalTurnScope,
  reservedBytes: number
): JournalTimelineItemResult {
  let scope = placement
  for (const key of resolution.scopeItemIds ?? []) {
    const item = view.item(key)
    if (item) {
      scope = item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      break
    }
  }
  const result = resolveTimelineItem(view, resolution, scope, reservedBytes)
  return result.kind === 'resolved' && scope !== placement
    ? { ...result, item: { ...result.item, turnScope: scope } }
    : result
}

function resolveTimelineItem(
  view: JournalTimelineView,
  resolution: JournalTimelineItemResolution,
  placement: AgentJournalTurnScope,
  reservedBytes: number
): JournalTimelineItemResult {
  switch (resolution.kind) {
    case 'literal':
      return resolved({ identity: resolution.identity, body: resolution.body })
    case 'acp-loss-warning': {
      const identity = parseAgentJournalItemKey(agentJournalItemKey(resolution.identity))
      const key =
        identity?.provider === 'legacy' ? spelledProviderTimelineItemKey(identity.recordId) : null
      if (key === null) {
        throw new Error('journal_acp_loss_warning_requires_provider_item_key')
      }
      return view.hasVisibleProviderItemKey(key)
        ? nothing
        : resolveJournalGuardedItem(
            view,
            { ...resolution, kind: 'guarded-item', change: 'update' },
            placement
          )
    }
    case 'request-open':
      return resolveProviderTimelineRequestOpen(view, {
        ...resolution,
        turnItemId: placement.kind === 'turn' ? placement.turnItemId : null
      })
    case 'turn-open':
      return resolveProviderTimelineTurnOpen(view, {
        identity: resolution.identity,
        body: resolution.body
      })
    case 'turn-opener':
      return resolved(
        resolveProviderTimelineTurnOpener(view, resolution.identity, resolution.message)
      )
    case 'turn-row':
      return resolved(
        resolveAgentJournalTurnRowWrite(view, resolution.target, resolution.write, reservedBytes)
      )
    case 'turn-claim': {
      const body = view.itemBody(agentJournalItemKey(resolution.identity))
      return body?.kind === 'turn' && body.state === 'running'
        ? resolved({
            identity: resolution.identity,
            body: { ...body, providerTurnId: resolution.providerTurnId }
          })
        : nothing
    }
    case 'background-task': {
      const identity = resolveClaudeBackgroundTaskIdentity(
        view.withKeyPrefix,
        resolution.taskId,
        resolution.toolUseId
      )
      const saved = view.itemBody(agentJournalItemKey(identity))
      const savedBlock =
        saved?.kind === 'message' ? saved.blocks.find(isBackgroundTaskBlock) : undefined
      const block =
        resolution.body.kind === 'message'
          ? resolution.body.blocks.find(isBackgroundTaskBlock)
          : undefined
      const alias = block?.parentToolUseId ?? savedBlock?.parentToolUseId
      return resolved({
        identity,
        body:
          block && alias && block.parentToolUseId === undefined
            ? backgroundTaskJournalBody({ ...block, parentToolUseId: alias })
            : resolution.body
      })
    }
    case 'thread-goal': {
      const identity = resolveCodexGoalIdentity(view.newestWithKeyPrefix, resolution.choice)
      return identity ? resolved({ identity, body: resolution.choice.body }) : nothing
    }
    case 'turn-failure':
      return resolved(mergeAgentJournalTurnFailure(view, resolution, resolution.voice))
    case 'quota-turn-end':
      return resolved(
        refineAgentJournalQuotaTurnEnd(
          view,
          resolution.identity,
          resolution.failureItemId,
          resolution.write
        )
      )
    case 'stop-decided': {
      const stopped = view.stopDecidesTurn(resolution.turnId, resolution.endedAt)
      const chosen = stopped ? resolution.stopped : resolution.ran
      const result = chosen
        ? resolveJournalTimelineItem(view, chosen, placement, reservedBytes)
        : nothing
      return stopped ? { ...result, stopped: true } : result
    }
    case 'text-snapshot':
    case 'guarded-item':
      return resolveJournalGuardedItem(view, resolution, placement)
  }
}

export function resolveJournalGuardedItem(
  view: Pick<JournalTimelineView, 'item' | 'itemBody'>,
  resolution: Extract<JournalTimelineItemResolution, { kind: 'text-snapshot' | 'guarded-item' }>,
  placement: AgentJournalTurnScope
): JournalTimelineItemResult {
  const held = view.item(agentJournalItemKey(resolution.identity))
  const scope = held ? (held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : placement
  if (resolution.kind === 'guarded-item') {
    if (
      (held?.body.kind === 'tool-call' &&
        held.body.state !== 'running' &&
        (resolution.change === 'close' || !isDeepStrictEqual(held.body, resolution.body))) ||
      relightsProviderTimelineBackgroundTask(held?.body ?? null, resolution.body)
    ) {
      return { kind: 'dropped', reason: 'item-settled' }
    }
    if (
      !requiresTerminalSettlement(resolution.body) ||
      (held && requiresTerminalSettlement(held.body))
    ) {
      return { kind: 'resolved', item: { identity: resolution.identity, body: resolution.body } }
    }
  }
  if (scope.kind === 'turn') {
    const turn = readAgentJournalTurn(view.itemBody(scope.turnItemId) ?? undefined)
    if (turn && turn.state !== 'running') {
      return { kind: 'dropped', reason: 'turn-settled', turnItemId: scope.turnItemId }
    }
  }
  return { kind: 'resolved', item: { identity: resolution.identity, body: resolution.body } }
}
