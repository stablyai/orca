import { agentSessionCurrentContextRows } from '../../../../shared/agent-session/agent-session-context-clear'
import { savedRewindKeys } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalSnapshot,
  AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReplacementItem } from '../../agent-session-journal/context-epochs/journal-epoch-replacement'
import { turnMembership } from '../rewind/structured-rewind-cut'
import { namedSubagents } from '../../../../shared/native-chat/transcript/native-chat-subagent-items'
import { isTerminalSubagentState } from '../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import { isSettledBackgroundTaskState } from '../../../../shared/native-chat/input/native-chat-background-task-row'
import {
  providerTimelineKeyPart,
  providerTimelineTurnKeyPart
} from '../../agent-session-timeline/provider-timeline-identity'
import { continuedOutsideRecordId } from './structured-agent-session-history-catch-up'

/** Freeze presentation once; native history supplies context and coverage, never the copied bodies. */
export function prepareForkSnapshot(input: {
  snapshot: AgentJournalSnapshot
  nextItemId: string | null
  sourceThreadId?: string
  childThreadId?: string
}): JournalReplacementItem[] {
  const { snapshot } = input
  const { items } = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
  const keys = savedRewindKeys(snapshot.submissions)
  const rowsById = new Map(items.map((item) => [item.itemId, item]))
  const member = input.sourceThreadId
    ? turnMembership(
        { itemBody: (id) => rowsById.get(id)?.body ?? null },
        items,
        input.sourceThreadId,
        keys.providerKey
      )
    : (item: (typeof items)[number]) =>
        item.turnScope?.kind === 'turn'
          ? item.turnScope.turnItemId
          : readAgentJournalTurn(item.body)
            ? item.itemId
            : undefined
  let end =
    input.nextItemId === null
      ? items.length
      : items.findIndex((item) => item.itemId === input.nextItemId)
  if (end < 0) {
    throw new Error('agent_session_fork:missing-boundary')
  }
  const next = items[end]
  if (next) {
    const nextTurn = member(next)
    end = items.findIndex(
      (item) => item === next || (nextTurn !== undefined && member(item) === nextTurn)
    )
  }
  const keptTurns = new Set(items.slice(0, end).flatMap((item) => member(item) ?? []))
  const candidates = items.filter((item, index) => index < end || keptTurns.has(member(item) ?? ''))
  const omitted = new Set(keys.omitted)
  const dependents = new Map<string, string[]>()
  const mapped = new Map<string, string>()
  const depend = (parent: string, child: string) => {
    const children = dependents.get(parent) ?? []
    children.push(child)
    dependents.set(parent, children)
  }
  for (const item of candidates) {
    const identity = parseAgentJournalItemKey(keys.providerKey(item.itemId))
    if (!identity) {
      throw new Error('agent_session_fork:missing-identity')
    }
    const target =
      identity.provider === 'codex' &&
      identity.threadId === input.sourceThreadId &&
      input.childThreadId
        ? {
            provider: identity.provider,
            threadId: input.childThreadId,
            turnId: identity.turnId,
            ordinal: identity.ordinal
          }
        : identity
    mapped.set(item.itemId, agentJournalItemKey(target))
    const references: string[] = []
    mapBodyLinks(item.body, (id) => {
      references.push(id)
      return id
    })
    if (item.turnScope?.kind === 'turn') {
      references.push(item.turnScope.turnItemId)
    }
    for (const ref of references) {
      depend(ref, item.itemId)
    }
    if (item.agentId !== undefined) {
      depend(`agent:${item.agentId}`, item.itemId)
      if (item.parentAgentId !== undefined) {
        depend(`agent:${item.parentAgentId}`, `agent:${item.agentId}`)
      }
    }
    if (item.providerParentRef !== undefined) {
      depend(`tool:${item.providerParentRef}`, item.itemId)
      if (item.agentId !== undefined) {
        depend(`tool:${item.providerParentRef}`, `agent:${item.agentId}`)
      }
    }
    const body = item.body
    const calls =
      body.kind === 'tool-call'
        ? [body]
        : body.kind === 'message'
          ? body.blocks.filter((block) => block.type === 'tool-call')
          : []
    for (const call of calls) {
      if (call.callId !== undefined) {
        depend(item.itemId, `tool:${call.callId}`)
      }
    }
    const helpers = body.kind === 'message' ? body.blocks.flatMap(namedSubagents) : []
    for (const helper of helpers) {
      depend(item.itemId, `agent:${helper.id}`)
    }
    if (
      helpers.some((helper) => !isTerminalSubagentState(helper.state)) ||
      readAgentJournalTurn(body)?.state === 'running' ||
      (body.kind === 'tool-call' && body.state === 'running') ||
      (body.kind === 'message' &&
        (body.state === 'running' ||
          body.blocks.some(
            (block) =>
              (block.type === 'background-task' && !isSettledBackgroundTaskState(block.state)) ||
              (block.type === 'tool-call' && block.state === 'running')
          ))) ||
      ((body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending') ||
      (body.kind === 'status' && (body.threadGoal !== undefined || body.forkedFrom !== undefined))
    ) {
      omitted.add(item.itemId)
    }
  }
  const pending = [...omitted]
  for (let index = 0; index < pending.length; index++) {
    for (const child of dependents.get(pending[index]!) ?? []) {
      if (!omitted.has(child)) {
        omitted.add(child)
        pending.push(child)
      }
    }
  }
  const retained = candidates.filter((item) => !omitted.has(item.itemId))
  const noticePrefix = continuedOutsideRecordId('')
  const notices = new Map<string, string>()
  const lastWork = new Map<string, number>()
  const scoped = (...parts: string[]) => JSON.stringify(parts)
  for (const [index, item] of retained.entries()) {
    const identity = parseAgentJournalItemKey(keys.providerKey(item.itemId))!
    if (identity.provider === 'legacy' && identity.recordId.startsWith(noticePrefix)) {
      const anchor = identity.recordId.slice(noticePrefix.length)
      notices.set(
        item.itemId,
        identity.agent === 'codex'
          ? scoped('codex', anchor)
          : identity.agent === 'claude'
            ? scoped('row', anchor)
            : scoped(identity.agent, identity.sessionId, providerTimelineKeyPart(anchor))
      )
      continue
    }
    if (readAgentJournalTurn(item.body)) {
      continue
    }
    lastWork.set(scoped('row', item.itemId), index)
    lastWork.set(scoped('row', keys.providerKey(item.itemId)), index)
    const turn = member(item)
    if (input.sourceThreadId && turn !== undefined) {
      lastWork.set(scoped('codex', turn), index)
    } else if (item.turnScope?.kind === 'turn') {
      const root = rowsById.get(item.turnScope.turnItemId)
      const rootIdentity = root && parseAgentJournalItemKey(keys.providerKey(root.itemId))
      const lifecycle = root && readAgentJournalTurn(root.body)
      const keyPart = lifecycle && providerTimelineTurnKeyPart(lifecycle.turnId)
      if (rootIdentity?.provider === 'legacy' && keyPart !== null && keyPart !== undefined) {
        lastWork.set(scoped(rootIdentity.agent, rootIdentity.sessionId, keyPart), index)
      }
    }
  }
  const rewrite = (id: string) => mapped.get(id) ?? id
  return retained
    .filter((item, index) => {
      const anchor = notices.get(item.itemId)
      return anchor === undefined || (lastWork.get(anchor) ?? -1) > index
    })
    .map((item) => {
      const identity = parseAgentJournalItemKey(mapped.get(item.itemId)!)!
      const body: AgentJournalItemBody = mapBodyLinks(
        JSON.parse(JSON.stringify(item.body)),
        rewrite
      )
      return {
        identity,
        body,
        observedAt: item.observedAt,
        ownerFence: 0,
        ...agentJournalLinkageFields(item),
        ...(item.turnScope
          ? {
              turnScope:
                item.turnScope.kind === 'turn'
                  ? {
                      kind: 'turn' as const,
                      turnItemId: mapped.get(item.turnScope.turnItemId) ?? item.turnScope.turnItemId
                    }
                  : { ...item.turnScope }
            }
          : {})
      }
    })
}

/** Visit only journal links; provider tool arguments and payloads are ordinary frozen content. */
function mapBodyLinks(
  body: AgentJournalItemBody,
  link: (id: string) => string
): AgentJournalItemBody {
  if (body.kind === 'turn' && body.userItemId !== undefined) {
    return { ...body, userItemId: link(body.userItemId) }
  }
  if (body.kind === 'status' && body.turnLifecycle?.userItemId !== undefined) {
    return {
      ...body,
      turnLifecycle: { ...body.turnLifecycle, userItemId: link(body.turnLifecycle.userItemId) }
    }
  }
  if (body.kind !== 'message') {
    return body
  }
  return {
    ...body,
    blocks: body.blocks.map((block) => {
      if (block.type === 'tool-result' && block.fullOutputItemId !== undefined) {
        return { ...block, fullOutputItemId: link(block.fullOutputItemId) }
      }
      if (block.type !== 'text') {
        return block
      }
      return {
        ...block,
        ...(block.usageLimitTurnItemId !== undefined
          ? { usageLimitTurnItemId: link(block.usageLimitTurnItemId) }
          : {}),
        ...(block.orcaStop?.turnItemId !== undefined
          ? { orcaStop: { ...block.orcaStop, turnItemId: link(block.orcaStop.turnItemId) } }
          : {})
      }
    })
  }
}
