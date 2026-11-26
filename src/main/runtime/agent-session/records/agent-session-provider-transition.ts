import { isDeepStrictEqual } from 'node:util'
import { agentSessionLeaseIsReleased } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  botProviderSelectionWithoutConsent,
  type AgentSessionProviderSelection,
  type AgentSessionProviderSetup
} from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'

export type AgentSessionProviderCommand =
  | { kind: 'select-provider'; selection: AgentSessionProviderSelection | null; now: number }
  | {
      kind: 'begin-provider-switch'
      target: AgentSessionProviderSetup
      clientMessageId: string
      hostRunId: string
      through: AgentJournalCursor
      now: number
    }
  | {
      kind: 'settle-provider-switch'
      clientMessageId: string
      outcome: 'delivered' | 'failed'
      deferContextThrough?: AgentJournalCursor
      now: number
    }
  | { kind: 'deliver-deferred-provider-context'; marker: string; clientMessageId?: string }

export function applyAgentSessionProviderCommand(
  record: AgentSessionRecord,
  command: AgentSessionProviderCommand
): AgentSessionRecord {
  switch (command.kind) {
    case 'select-provider': {
      if (!command.selection || command.selection.agent === record.provider) {
        const { selectedProvider: previous, ...rest } = record
        return previous ? { ...rest, updatedAt: command.now } : record
      }
      return isDeepStrictEqual(record.selectedProvider, command.selection)
        ? record
        : { ...record, selectedProvider: command.selection, updatedAt: command.now }
    }
    case 'begin-provider-switch':
      return beginProviderSwitch(record, command)
    case 'settle-provider-switch':
      return settleProviderSwitch(record, command)
    case 'deliver-deferred-provider-context': {
      const { deferredProviderContext, ...retained } = record
      if (deferredProviderContext?.marker !== command.marker) {
        return record
      }
      return command.clientMessageId
        ? {
            ...retained,
            deferredProviderContext: {
              ...deferredProviderContext,
              attachedTo: command.clientMessageId
            }
          }
        : retained
    }
  }
}

function beginProviderSwitch(
  record: AgentSessionRecord,
  command: Extract<AgentSessionProviderCommand, { kind: 'begin-provider-switch' }>
): AgentSessionRecord {
  if (
    record.selectedProvider?.agent !== command.target.provider ||
    record.provider === command.target.provider ||
    record.providerSwitch ||
    !agentSessionLeaseIsReleased(record.lease)
  ) {
    throw new Error('agent_session_provider_switch_superseded')
  }
  const {
    selectedProvider,
    provider,
    accountHome,
    options,
    permissionMode,
    launchArgs,
    instructionsKey,
    rewind,
    acquiredAccount: _accountObservation,
    launchedAccount,
    ...rest
  } = record
  const head = record.providerHandleChain.at(-1)
  const retryHome = botProviderSelectionWithoutConsent(selectedProvider)
  return {
    ...rest,
    ...command.target,
    providerHandleChain: head
      ? [
          ...record.providerHandleChain.slice(0, -1),
          {
            ...head,
            seenThrough: command.through,
            accountHome: launchedAccount?.accountHome ?? accountHome,
            permissionMode: isAgentChatPermissionMode(permissionMode) ? permissionMode : 'ask'
          }
        ]
      : record.providerHandleChain,
    providerSwitch: {
      clientMessageId: command.clientMessageId,
      hostRunId: command.hostRunId,
      through: command.through,
      ...(retryHome ? { retryHome } : {}),
      ...(selectedProvider.consent?.queueThrough
        ? { queueBoundary: selectedProvider.consent.queueThrough }
        : {}),
      ...(head ? { fromLinkId: head.linkId } : {}),
      from: {
        provider,
        accountHome,
        ...(options ? { options } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(launchArgs ? { launchArgs } : {}),
        ...(instructionsKey ? { instructionsKey } : {}),
        ...(rewind ? { rewind } : {})
      }
    },
    lease: { ...record.lease, provenHandleLinkId: null },
    updatedAt: command.now
  }
}

function settleProviderSwitch(
  record: AgentSessionRecord,
  command: Extract<AgentSessionProviderCommand, { kind: 'settle-provider-switch' }>
): AgentSessionRecord {
  const { providerSwitch, ...rest } = record
  if (providerSwitch?.clientMessageId !== command.clientMessageId) {
    return record
  }
  if (command.outcome === 'delivered') {
    const {
      deferredProviderContext: _previous,
      providerSwitchQueueBoundary: _queue,
      ...active
    } = rest
    return {
      ...active,
      ...(providerSwitch.queueBoundary
        ? { providerSwitchQueueBoundary: providerSwitch.queueBoundary }
        : {}),
      ...(command.deferContextThrough
        ? {
            deferredProviderContext: {
              marker: command.clientMessageId,
              from: providerSwitch.from.provider,
              through: command.deferContextThrough,
              clearKey: record.providerContextBoundary?.operationId ?? null
            }
          }
        : {}),
      updatedAt: command.now
    }
  }
  if (!agentSessionLeaseIsReleased(record.lease)) {
    throw new Error('agent_session_provider_switch_owner_not_released')
  }
  const {
    options: _options,
    permissionMode: _permission,
    launchArgs: _args,
    instructionsKey: _instructions,
    rewind: _rewind,
    acquiredAccount: _acquiredAccount,
    launchedAccount: _launchedAccount,
    selectedProvider: nextSelection,
    ...previous
  } = rest
  const through = record.providerHandleChain.findIndex(
    ({ linkId }) => linkId === providerSwitch.fromLinkId
  )
  const selected = nextSelection ?? providerSwitch.retryHome
  return {
    ...previous,
    ...providerSwitch.from,
    ...(selected && selected.agent !== providerSwitch.from.provider
      ? { selectedProvider: selected }
      : {}),
    providerHandleChain: record.providerHandleChain.slice(0, through + 1),
    lease: { ...record.lease, provenHandleLinkId: null },
    updatedAt: command.now
  }
}
