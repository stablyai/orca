import { AGENT_CHAT_PERMISSION_MODES } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  botProviderSelectionWithoutConsent,
  providerSwitchPermission
} from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import { adapterSupportsCreateIfDeclared } from '../providers/structured-agent-session-provider-support'
import { attachParamsForRecord } from '../host/structured-agent-session-conversation-open'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentChatPermissionModes } from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'

import {
  providerSwitchHostRunId,
  providerSwitchSourcePermission,
  type ProviderSelectionHost
} from './structured-agent-session-provider-selection'

function queuedBeforeConsent(
  queuedAt: AgentJournalCursor | null | undefined,
  boundary: AgentJournalCursor,
  currentEpoch: string
): boolean {
  return (
    !queuedAt ||
    (queuedAt.epoch === boundary.epoch
      ? queuedAt.sequence <= boundary.sequence
      : queuedAt.epoch !== currentEpoch)
  )
}

async function refuseProviderSwitchSend(
  session: StructuredAgentSessionHostSession,
  record: AgentSessionRecord,
  next: AgentJournalSubmission,
  failure:
    | 'providerSwitchConsentRequired'
    | 'providerSwitchPlanMode'
    | 'providerSwitchUnavailable'
    | 'providerSwitchQueuedPermission',
  target?: string
): Promise<'rejected'> {
  const fence = record.lease.runtimeFence
  const rejection = agentSessionFailureWords(
    agentSessionFailureFact(failure, { neverReachedAgent: true }),
    {
      surface: 'rejection'
    }
  )
  if (target) {
    await appendProviderHandoff(
      session,
      next.clientMessageId,
      record.provider,
      target,
      fence,
      rejection.reason
    )
  }
  await session.journal.resolveDispatch({
    clientMessageId: next.clientMessageId,
    fence,
    state: 'rejected',
    ...rejection
  })
  return 'rejected'
}

export async function prepareStructuredChatProviderSwitch(
  host: ProviderSelectionHost,
  session: StructuredAgentSessionHostSession,
  next: AgentJournalSubmission,
  hasWork: () => Promise<boolean>,
  stop: () => Promise<void>
): Promise<'none' | 'blocked' | 'changed' | 'rejected'> {
  const sessionId = session.params.envelope.sessionId
  const { deps } = host
  const record = deps.store.getRecord(sessionId)
  let selection = record?.selectedProvider
  if (!record || record.providerSwitch || (!selection && !record.providerSwitchQueueBoundary)) {
    return 'none'
  }
  if (
    selection?.botDefault &&
    deps.botHomeDefault?.(selection.botDefault, sessionId, record.location.workspaceId) !==
      selection.agent
  ) {
    await deps.store.updateRecord(sessionId, {
      kind: 'select-provider',
      selection: null,
      now: host.now()
    })
    host.publish(sessionId)
    selection = undefined
  }
  const activeBoundary = record.providerSwitchQueueBoundary
  const preConsent = deps.isPreConsentOperation?.(sessionId, next.clientMessageId) === true
  const queued =
    next.queuedMessageId && (activeBoundary || selection?.consent)
      ? await session.journal.queuedMessages.get(next.queuedMessageId)
      : undefined
  const body = selection
    ? await session.journal.reads.itemBody(agentJournalSubmissionKey(next.clientMessageId))
    : undefined
  const allowsSwitch = body?.kind === 'message' && !body.command
  if (
    activeBoundary &&
    (preConsent ||
      (next.queuedMessageId &&
        queuedBeforeConsent(
          queued?.queuedAt,
          activeBoundary,
          session.journal.physicalCursor().epoch
        ))) &&
    !(allowsSwitch && selection && agentChatPermissionModes(selection.agent))
  ) {
    return refuseProviderSwitchSend(session, record, next, 'providerSwitchQueuedPermission')
  }
  if (!selection || !allowsSwitch) {
    return 'none'
  }
  if (await hasWork()) {
    return 'blocked'
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
    const physical = session.journal.physicalCursor()
    if (
      consent?.from !== record.provider ||
      consent.fromPermission !== fromPermission ||
      consent.hostRunId !== providerSwitchHostRunId(deps) ||
      consent.queueThrough?.epoch !== physical.epoch ||
      consent.through.epoch !== cursor.epoch
    ) {
      await deps.store.updateRecord(sessionId, {
        kind: 'select-provider',
        selection: botProviderSelectionWithoutConsent(selection),
        now: host.now()
      })
      host.publish(sessionId)
      return refuseProviderSwitchSend(
        session,
        record,
        next,
        'providerSwitchConsentRequired',
        selection.agent
      )
    }
    if (preConsent || (next.submittedSequence ?? 0) <= consent.queueThrough.sequence) {
      return 'none'
    }
    if (
      next.queuedMessageId &&
      queuedBeforeConsent(queued?.queuedAt, consent.queueThrough, physical.epoch)
    ) {
      return 'none'
    }
    // Admission delivers older submitted messages first. Drafts that could not be admitted are
    // checked when they are eventually dispatched, without blocking newer sends.
  }
  if (record.provider === 'claude' && record.options?.interactionMode === 'plan') {
    if (requiresConsent) {
      await deps.store.updateRecord(sessionId, {
        kind: 'select-provider',
        selection: botProviderSelectionWithoutConsent(selection),
        now: host.now()
      })
      host.publish(sessionId)
    }
    return refuseProviderSwitchSend(
      session,
      record,
      next,
      'providerSwitchPlanMode',
      selection.agent
    )
  }
  let switched: AgentSessionRecord
  try {
    if (
      deps.canSwitchProvider?.(sessionId, selection.agent) === false ||
      !adapterSupportsCreateIfDeclared(deps.adapter, record.location, selection.agent)
    ) {
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
    switched = await deps.store.updateRecord(sessionId, {
      kind: 'begin-provider-switch',
      clientMessageId: next.clientMessageId,
      hostRunId: providerSwitchHostRunId(deps),
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
  } catch (error) {
    deps.logger?.warn('preparing a chat agent handoff failed', {
      scope: 'provider-switch-preparation',
      sessionId,
      error
    })
    await deps.store.updateRecord(sessionId, {
      kind: 'select-provider',
      selection: botProviderSelectionWithoutConsent(selection),
      now: host.now()
    })
    host.publish(sessionId)
    return refuseProviderSwitchSend(
      session,
      record,
      next,
      'providerSwitchUnavailable',
      selection.agent
    )
  }
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
  await appendProviderHandoff(
    session,
    handoff.clientMessageId,
    handoff.from.provider,
    record.provider,
    fence,
    failed
  )
}

async function appendProviderHandoff(
  session: StructuredAgentSessionHostSession,
  clientMessageId: string,
  source: string,
  target: string,
  fence: number,
  failure: boolean | string
): Promise<void> {
  const from = tuiAgentDisplayName(source) ?? source
  const to = tuiAgentDisplayName(target) ?? target
  const retry = failure === true ? 'Retry sends to the agent shown in the composer.' : failure
  await session.journal.appendItem(
    { provider: 'orca', clientMessageId: `context-handoff:${clientMessageId}` },
    {
      kind: 'status',
      presentation: 'context-handoff',
      text: `Context handoff · ${from} → ${to}${typeof retry === 'string' ? ` · ${retry}` : ''}`,
      ...(failure ? { tone: 'error' } : {})
    },
    { fence, turnScope: { kind: 'thread' } }
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
