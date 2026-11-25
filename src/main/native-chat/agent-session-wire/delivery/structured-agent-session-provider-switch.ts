import { randomUUID } from 'node:crypto'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  providerSwitchPermission,
  type AgentSessionSelectProviderParams,
  type AgentSessionSelectProviderResult
} from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { adapterSupportsCreateIfDeclared } from '../providers/structured-agent-session-provider-support'
import { structuredAgentSessionOptionOverridesRefusal } from '../options/structured-agent-session-option-intent'
import { attachParamsForRecord } from '../host/structured-agent-session-conversation-open'
import { continuationContextReader } from '../recovery/structured-agent-session-continuation-context'
import { buildAgentSessionContinuationPrompt } from '../../../../shared/agent-session/conversation-context/agent-session-continuation'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isUnsettledQueuedMessage } from '../../agent-session-journal/queued-messages/queued-message-table'

// A crash before the handoff must leave the next send subject to a fresh confirmation.
const hostRunId = randomUUID()

type ProviderSelectionHost = {
  deps: StructuredAgentSessionHostDeps
  publish: (sessionId: string) => void
  now: () => number
}

export function providerSwitchSourcePermission(
  record: Pick<AgentSessionRecord, 'permissionMode'>
): AgentChatPermissionMode {
  return isAgentChatPermissionMode(record.permissionMode) ? record.permissionMode : 'ask'
}

/** The current reply owns the child until delivery chooses a fresh turn. */
export async function selectStructuredChatProvider(
  host: ProviderSelectionHost,
  session: StructuredAgentSessionHostSession,
  { sessionId, agent, options, consent }: AgentSessionSelectProviderParams,
  botDefault?: string
): Promise<AgentSessionSelectProviderResult> {
  const { deps } = host
  const record = deps.store.requireWritableRecord(sessionId)
  const selection = {
    agent,
    ...(options ? { options } : {}),
    ...(botDefault ? { botDefault } : {})
  }
  if (agent !== record.provider) {
    if (
      !deps.resolveProviderSwitchAccount ||
      !deps.agents.definition(agent) ||
      !adapterSupportsCreateIfDeclared(deps.adapter, record.location, agent)
    ) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const refusal =
      options && structuredAgentSessionOptionOverridesRefusal(deps.agents, agent, options)
    if (refusal) {
      throw new AgentSessionRefusalError(refusal)
    }
    const fromPermission = providerSwitchSourcePermission(record)
    if (providerSwitchPermission(fromPermission, agent).requiresConsent) {
      const previous = record.selectedProvider
      const previousConsent = previous?.consent
      const cursor = await session.journal.reads.cursor()
      if (
        !consent &&
        previous?.agent === agent &&
        previousConsent?.from === record.provider &&
        previousConsent.fromPermission === fromPermission &&
        previousConsent.through.epoch === cursor.epoch
      ) {
        await deps.store.updateRecord(sessionId, {
          kind: 'select-provider',
          selection: { ...selection, consent: previousConsent },
          now: host.now()
        })
        return { status: 'selected' }
      }
      if (
        consent?.from !== record.provider ||
        consent.fromPermission !== fromPermission ||
        consent.permission !== 'full-access'
      ) {
        return { status: 'consent-required', from: record.provider, fromPermission }
      }
      await deps.store.updateRecord(sessionId, {
        kind: 'select-provider',
        selection: {
          ...selection,
          consent: { from: record.provider, fromPermission, through: cursor }
        },
        now: host.now()
      })
      return { status: 'selected' }
    }
  }
  await deps.store.updateRecord(sessionId, { kind: 'select-provider', selection, now: host.now() })
  return { status: 'selected' }
}

export async function prepareStructuredChatProviderSwitch(
  host: ProviderSelectionHost,
  session: StructuredAgentSessionHostSession,
  next: AgentJournalSubmission,
  hasWork: () => Promise<boolean>,
  stop: () => Promise<void>
): Promise<'none' | 'blocked' | 'changed'> {
  const sessionId = session.params.envelope.sessionId
  const { deps } = host
  const record = deps.store.getRecord(sessionId)
  const selection = record?.selectedProvider
  if (!record || !selection || record.providerSwitch) {
    return 'none'
  }
  if (
    selection.botDefault &&
    deps.botHomeDefault?.(selection.botDefault, sessionId) !== selection.agent
  ) {
    await deps.store.updateRecord(sessionId, {
      kind: 'select-provider',
      selection: null,
      now: host.now()
    })
    host.publish(sessionId)
    return 'none'
  }
  const body = await session.journal.reads.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  if (body?.kind !== 'message' || body.command) {
    return 'none'
  }
  const fromPermission = providerSwitchSourcePermission(record)
  const previous = record.providerHandleChain.findLast(
    ({ handle }) => handle.agent === selection.agent
  )
  const { permission, requiresConsent } = providerSwitchPermission(fromPermission, selection.agent)
  const maximumReturningPermission = previous?.permissionMode
  const returningPermission =
    maximumReturningPermission &&
    AGENT_CHAT_PERMISSION_MODES.indexOf(maximumReturningPermission) <
      AGENT_CHAT_PERMISSION_MODES.indexOf(permission)
      ? providerSwitchPermission(maximumReturningPermission, selection.agent).permission
      : permission
  if (requiresConsent) {
    const consent = selection.consent
    const cursor = session.journal.cursor()
    if (
      consent?.from !== record.provider ||
      consent.fromPermission !== fromPermission ||
      consent.through.epoch !== cursor.epoch
    ) {
      await deps.store.updateRecord(sessionId, {
        kind: 'select-provider',
        selection: null,
        now: host.now()
      })
      host.publish(sessionId)
      throw new Error('agent_session_provider_switch_consent_changed')
    }
    if ((next.submittedSequence ?? 0) <= consent.through.sequence) {
      return 'none'
    }
    if (next.queuedMessageId) {
      const draft = await session.journal.queuedMessages.get(next.queuedMessageId)
      if (!draft?.queuedAt || draft.queuedAt.sequence <= consent.through.sequence) {
        return 'none'
      }
    }
    const queued = await session.journal.queuedMessages.list()
    const pending = await session.journal.reads.pendingSubmissions()
    if (
      queued.some(
        (draft) =>
          isUnsettledQueuedMessage(draft) &&
          (!draft.queuedAt || draft.queuedAt.sequence <= consent.through.sequence)
      ) ||
      pending.some((submission) => (submission.submittedSequence ?? 0) <= consent.through.sequence)
    ) {
      throw new Error(
        'Earlier queued messages must be sent or removed before switching to broader access.'
      )
    }
  }
  if (await hasWork()) {
    return 'blocked'
  }
  if (record.provider === 'claude' && record.options?.interactionMode === 'plan') {
    throw new Error('Exit plan mode before switching agents.')
  }
  if (!adapterSupportsCreateIfDeclared(deps.adapter, record.location, selection.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  if (session.child) {
    await stop()
  }
  const accountHome =
    previous?.accountHome ??
    (await deps.resolveProviderSwitchAccount?.(record, selection.agent, returningPermission))
  if (!accountHome) {
    throw new Error('agent_session_provider_switch_unavailable')
  }
  const through = await session.journal.reads.cursor()
  const switched = await deps.store.updateRecord(sessionId, {
    kind: 'begin-provider-switch',
    clientMessageId: next.clientMessageId,
    hostRunId,
    through,
    target: {
      provider: selection.agent,
      accountHome,
      ...(selection.options ? { options: selection.options } : {}),
      // A grant meant for a provider with no Orca permission control does not widen the retained preference.
      permissionMode: requiresConsent ? fromPermission : returningPermission
    },
    now: host.now()
  })
  setProviderSwitchSessionParams(session, switched)
  await recordProviderHandoff(session, switched, switched.lease.runtimeFence, false)
  host.publish(sessionId)
  return 'changed'
}

export async function recordProviderHandoff(
  session: StructuredAgentSessionHostSession,
  record: AgentSessionRecord,
  fence: number,
  failed: boolean
): Promise<void> {
  const handoff = record.providerSwitch
  if (!handoff) {
    return
  }
  const from = tuiAgentDisplayName(handoff.from.provider) ?? handoff.from.provider
  const to = tuiAgentDisplayName(record.provider) ?? record.provider
  await session.journal.appendItem(
    { provider: 'orca', clientMessageId: `context-handoff:${handoff.clientMessageId}` },
    {
      kind: 'status',
      presentation: 'context-handoff',
      text: `Context handoff · ${from} → ${to}`,
      ...(failed ? { tone: 'error' } : {})
    },
    { fence, turnScope: { kind: 'thread' } }
  )
}

export function isCurrentProviderSwitch(
  record: Pick<AgentSessionRecord, 'providerSwitch'>,
  clientMessageId: string | undefined
): boolean {
  return (
    record.providerSwitch?.hostRunId === hostRunId &&
    record.providerSwitch.clientMessageId === clientMessageId
  )
}

export function setProviderSwitchSessionParams(
  session: StructuredAgentSessionHostSession,
  record: AgentSessionRecord
): void {
  session.params = attachParamsForRecord(record, {
    clientOperationId: session.params.envelope.clientOperationId,
    expectedRuntimeFence: record.lease.runtimeFence
  })
}

export async function readStructuredChatProviderSwitchPrompt(
  deps: StructuredAgentSessionHostDeps,
  session: StructuredAgentSessionHostSession,
  clientMessageId: string
): Promise<string | null> {
  const sessionId = session.params.envelope.sessionId
  const record = deps.store.getRecord(sessionId)
  const switching = record?.providerSwitch
  if (!switching || switching.clientMessageId !== clientMessageId) {
    return null
  }
  const previous = record.providerHandleChain.findLast(
    ({ handle, seenThrough }) => handle.agent === record.provider && seenThrough !== undefined
  )
  const read = continuationContextReader(deps, () => Promise.resolve(session))
  const context = await read({
    sessionId,
    workspaceId: record.location.workspaceId,
    expectedCursor: switching.through,
    inPlace: previous?.seenThrough ? { after: previous.seenThrough } : {}
  })
  if (context.status !== 'current') {
    throw new Error('agent_session_provider_switch_context_superseded')
  }
  const source = switching.from.provider
  return buildAgentSessionContinuationPrompt(
    {
      sourceAgent: isTuiAgent(source) ? source : null,
      sourceKind: 'chat',
      capturedText: context.capturedText ?? '',
      sourceTitle: record.conversationName,
      transcriptPath: context.transcriptPath
    },
    'in-place'
  )
}
