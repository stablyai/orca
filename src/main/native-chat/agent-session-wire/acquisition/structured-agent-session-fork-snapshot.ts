import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { namedSubagents } from '../../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { isTerminalSubagentState } from '../../../../shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import { isSettledBackgroundTaskState } from '../../../../shared/native-chat/input/task-lists/native-chat-background-task-row'

/** Visit only journal links; provider tool arguments and payloads are ordinary frozen content. */
export function mapBodyLinks(
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

/** One edge at a time lets private preparation yield even when one body names many dependents. */
export function* forkDependencies(
  item: AgentJournalRenderItem
): Generator<readonly [string, string]> {
  const body = item.body
  if (body.kind === 'turn' && body.userItemId !== undefined) {
    yield [body.userItemId, item.itemId]
  }
  if (body.kind === 'status' && body.turnLifecycle?.userItemId !== undefined) {
    yield [body.turnLifecycle.userItemId, item.itemId]
  }
  if (item.turnScope?.kind === 'turn') {
    yield [item.turnScope.turnItemId, item.itemId]
  }
  if (item.agentId !== undefined) {
    yield [`agent:${item.agentId}`, item.itemId]
    if (item.parentAgentId !== undefined) {
      yield [`agent:${item.parentAgentId}`, `agent:${item.agentId}`]
    }
  }
  if (item.providerParentRef !== undefined) {
    yield [`tool:${item.providerParentRef}`, item.itemId]
    if (item.agentId !== undefined) {
      yield [`tool:${item.providerParentRef}`, `agent:${item.agentId}`]
    }
  }
  if (body.kind === 'tool-call' && body.callId !== undefined) {
    yield [item.itemId, `tool:${body.callId}`]
  }
  if (body.kind === 'message') {
    for (const block of body.blocks) {
      if (block.type === 'tool-result' && block.fullOutputItemId !== undefined) {
        yield [block.fullOutputItemId, item.itemId]
      }
      if (block.type === 'text') {
        if (block.usageLimitTurnItemId !== undefined) {
          yield [block.usageLimitTurnItemId, item.itemId]
        }
        if (block.orcaStop?.turnItemId !== undefined) {
          yield [block.orcaStop.turnItemId, item.itemId]
        }
      }
      if (block.type === 'tool-call' && block.callId !== undefined) {
        yield [item.itemId, `tool:${block.callId}`]
      }
      for (const helper of namedSubagents(block)) {
        yield [item.itemId, `agent:${helper.id}`]
      }
    }
  }
}

export function omitForkPresentation(body: AgentJournalItemBody): boolean {
  const hasUnsettledHelper =
    body.kind === 'message' &&
    body.blocks.some((block) =>
      namedSubagents(block).some((helper) => !isTerminalSubagentState(helper.state))
    )
  return (
    hasUnsettledHelper ||
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
  )
}
