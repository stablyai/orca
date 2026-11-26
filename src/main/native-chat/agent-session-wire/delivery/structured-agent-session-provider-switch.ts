import {
  isNativeProviderCommand,
  readStructuredChatProviderSwitchPrompt
} from './structured-agent-session-provider-handover'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { providerSwitchPermission } from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { adapterSupportsCreateIfDeclared } from '../providers/structured-agent-session-provider-support'
import { attachParamsForRecord } from '../host/structured-agent-session-conversation-open'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isUnsettledQueuedMessage } from '../../agent-session-journal/queued-messages/queued-message-table'

import {
  providerSwitchHostRunId,
  providerSwitchSourcePermission,
  type ProviderSelectionHost
} from './structured-agent-session-provider-selection'

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
    if (
      consent?.from !== record.provider ||
      consent.fromPermission !== fromPermission ||
      consent.hostRunId !== providerSwitchHostRunId(deps) ||
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
      return 'blocked'
    }
  }
  if (record.provider === 'claude' && record.options?.interactionMode === 'plan') {
    throw new Error('Exit plan mode before switching agents.')
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
    if (requiresConsent) {
      await deps.store.updateRecord(sessionId, {
        kind: 'select-provider',
        selection: null,
        now: host.now()
      })
      host.publish(sessionId)
    }
    throw error
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
  deps: StructuredAgentSessionHostDeps,
  record: Pick<AgentSessionRecord, 'providerSwitch'>,
  clientMessageId: string | undefined
): boolean {
  return (
    record.providerSwitch?.hostRunId === providerSwitchHostRunId(deps) &&
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

export function wireStructuredChatProviderSwitch(
  host: ProviderSelectionHost & {
    hasWork: (id: string, submission: AgentJournalSubmission) => Promise<boolean>
    stop: (id: string) => Promise<void>
  }
): Pick<
  StructuredAgentSessionDeliveryLoopDeps,
  | 'prepareProviderSwitch'
  | 'settleProviderSwitch'
  | 'providerSwitchPrompt'
  | 'reconcileProviderSwitch'
> {
  const settleProviderSwitch: NonNullable<
    StructuredAgentSessionDeliveryLoopDeps['settleProviderSwitch']
  > = async (session, clientMessageId, outcome) => {
    const id = session.params.envelope.sessionId
    const current = host.deps.store.getRecord(id)
    if (current?.providerSwitch?.clientMessageId !== clientMessageId) {
      return
    }
    if (outcome === 'failed' && session.child) {
      await host.stop(id)
    }
    const body =
      outcome === 'delivered'
        ? await session.journal.reads.itemBody(agentJournalSubmissionKey(clientMessageId))
        : undefined
    const record = await host.deps.store.updateRecord(id, {
      kind: 'settle-provider-switch',
      clientMessageId,
      outcome,
      now: host.now(),
      ...(body?.kind === 'message' && isNativeProviderCommand(body) ? { deferContext: true } : {})
    })
    setProviderSwitchSessionParams(session, record)
    if (outcome === 'failed') {
      await recordProviderHandoff(session, current, record.lease.runtimeFence, true)
    }
    host.publish(id)
  }
  return {
    reconcileProviderSwitch: async (session, clientMessageId) => {
      const record = host.deps.store.getRecord(session.params.envelope.sessionId)
      const switching = record?.providerSwitch
      if (!switching || isCurrentProviderSwitch(host.deps, record, clientMessageId)) {
        return 'current'
      }
      const original = await session.journal.reads.submission(switching.clientMessageId)
      if (
        original?.dispatchState === 'pending' &&
        original.handedOverAt !== undefined &&
        isCurrentProviderSwitch(host.deps, record, switching.clientMessageId) &&
        session.child &&
        !session.child.close
      ) {
        return 'park'
      }
      await settleProviderSwitch(
        session,
        switching.clientMessageId,
        original?.dispatchState === 'accepted' ? 'delivered' : 'failed'
      )
      return 'settled'
    },
    prepareProviderSwitch: (session, submission) => {
      const id = session.params.envelope.sessionId
      return prepareStructuredChatProviderSwitch(
        host,
        session,
        submission,
        () => host.hasWork(id, submission),
        () => host.stop(id)
      )
    },
    settleProviderSwitch,
    providerSwitchPrompt: (session, clientMessageId) =>
      readStructuredChatProviderSwitchPrompt(host.deps, session, clientMessageId)
  }
}
