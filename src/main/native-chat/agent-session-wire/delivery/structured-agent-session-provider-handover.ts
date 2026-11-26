import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { buildAgentSessionContinuationPrompt } from '../../../../shared/agent-session/conversation-context/agent-session-continuation'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { continuationContextReader } from '../recovery/structured-agent-session-continuation-context'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHandoverContext,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session/agent-session-wire'
import {
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from '../../../../shared/native-chat/input/commands/native-chat-agent-profiles'

export async function structuredChatSwitchInput(
  deps: StructuredAgentSessionDeliveryLoopDeps,
  session: StructuredAgentSessionHostSession,
  next: AgentJournalSubmission
): Promise<
  Pick<AgentSessionHandoverContext, 'contextHandoff' | 'settleProviderSwitch'> & {
    submission: AgentJournalSubmission
  }
> {
  const record = deps.record(session.params.envelope.sessionId)
  const switching = record?.providerSwitch?.clientMessageId === next.clientMessageId
  if (!switching && !record?.deferredProviderContext) {
    return { submission: next }
  }
  const contextHandoff = await deps.providerSwitchPrompt?.(session, next.clientMessageId)
  return {
    submission: next,
    ...(contextHandoff ? { contextHandoff } : {}),
    ...(switching
      ? {
          settleProviderSwitch: (outcome: 'delivered' | 'failed') =>
            deps.settleProviderSwitch?.(session, next.clientMessageId, outcome)
        }
      : {})
  }
}

export function isNativeProviderCommand(
  body: { blocks: readonly { type: string }[] },
  provider: string,
  reported?: readonly AgentSessionSlashCommand[]
): boolean {
  const first = body.blocks[0]
  if (first?.type !== 'text' || !('text' in first) || typeof first.text !== 'string') {
    return false
  }
  const name = /^\/([\w:-]+)(?:\s|$)/.exec(first.text.trimStart())?.[1]?.toLowerCase()
  if (!name || !isTuiAgent(provider)) {
    return false
  }
  const profile = getNativeChatAgentProfile(provider)
  const namespace = profile?.skillNamePrefix
  return Boolean(
    reported?.some((command) => command.name === name) ||
    (namespace && name.startsWith(namespace) && name.length > namespace.length) ||
    profile?.textDrivenCommands?.includes(name) ||
    getVerifiedNativeChatCommands(provider).some((command) => command.name === name)
  )
}

export async function readStructuredChatProviderSwitchPrompt(
  deps: StructuredAgentSessionHostDeps,
  session: StructuredAgentSessionHostSession,
  clientMessageId: string
): Promise<string | null> {
  const sessionId = session.params.envelope.sessionId
  const record = deps.store.getRecord(sessionId)
  const switching =
    record?.providerSwitch?.clientMessageId === clientMessageId ? record.providerSwitch : undefined
  const deferred = switching ? undefined : record?.deferredProviderContext
  const handoff = switching
    ? { from: switching.from.provider, through: switching.through }
    : deferred
  if (!record || !handoff) {
    return null
  }
  const body = await session.journal.reads.itemBody(agentJournalSubmissionKey(clientMessageId))
  if (
    body?.kind !== 'message' ||
    body.command ||
    isNativeProviderCommand(body, record.provider, deps.adapter.readCommands?.(sessionId))
  ) {
    return null
  }
  if (deferred) {
    const marker = deferred.marker
    const clearKey = record.providerContextBoundary?.operationId ?? null
    const prior =
      deferred.attachedTo && deferred.attachedTo !== clientMessageId
        ? await session.journal.reads.submission(deferred.attachedTo)
        : undefined
    if (
      deferred.clearKey !== clearKey ||
      prior?.dispatchState === 'accepted' ||
      prior?.dispatchState === 'unknown'
    ) {
      await deps.store.updateRecord(sessionId, {
        kind: 'deliver-deferred-provider-context',
        marker
      })
      return null
    }
    if (prior?.dispatchState === 'pending' && prior.handedOverAt !== undefined) {
      return null
    }
    await deps.store.updateRecord(sessionId, {
      kind: 'deliver-deferred-provider-context',
      marker,
      clientMessageId
    })
  }
  const previous = record.providerHandleChain.findLast(
    ({ handle, seenThrough }) => handle.agent === record.provider && seenThrough !== undefined
  )
  const read = continuationContextReader(deps, () => Promise.resolve(session))
  const context = await read({
    sessionId,
    workspaceId: record.location.workspaceId,
    expectedCursor: handoff.through,
    inPlace: previous?.seenThrough ? { after: previous.seenThrough } : {}
  })
  if (context.status !== 'current') {
    throw new Error('agent_session_provider_switch_context_superseded')
  }
  return buildAgentSessionContinuationPrompt(
    {
      sourceAgent: isTuiAgent(handoff.from) ? handoff.from : null,
      sourceKind: 'chat',
      capturedText: context.capturedText ?? '',
      sourceTitle: record.conversationName,
      transcriptPath: context.transcriptPath
    },
    'in-place'
  )
}
