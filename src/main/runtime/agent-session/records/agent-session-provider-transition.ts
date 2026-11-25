import { agentSessionLeaseIsReleased } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionProviderSelection,
  AgentSessionProviderSetup
} from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'

export type AgentSessionProviderCommand =
  | { kind: 'select-provider'; selection: AgentSessionProviderSelection | null; now: number }
  | {
      kind: 'begin-provider-switch'
      target: AgentSessionProviderSetup
      clientMessageId: string
      through: AgentJournalCursor
      now: number
    }
  | {
      kind: 'settle-provider-switch'
      clientMessageId: string
      outcome: 'delivered' | 'failed'
      now: number
    }

export function applyAgentSessionProviderCommand(
  record: AgentSessionRecord,
  command: AgentSessionProviderCommand
): AgentSessionRecord {
  switch (command.kind) {
    case 'select-provider': {
      const { selectedProvider: previous, ...rest } = record
      if (!command.selection || command.selection.agent === record.provider) {
        return previous ? { ...rest, updatedAt: command.now } : record
      }
      return { ...rest, selectedProvider: command.selection, updatedAt: command.now }
    }
    case 'begin-provider-switch':
      return beginProviderSwitch(record, command)
    case 'settle-provider-switch':
      return settleProviderSwitch(record, command)
  }
}

function beginProviderSwitch(
  record: AgentSessionRecord,
  command: Extract<AgentSessionProviderCommand, { kind: 'begin-provider-switch' }>
): AgentSessionRecord {
  if (
    record.selectedProvider?.agent !== command.target.provider ||
    record.providerSwitch ||
    !agentSessionLeaseIsReleased(record.lease)
  ) {
    throw new Error('agent_session_provider_switch_superseded')
  }
  const {
    selectedProvider: _selection,
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
  return {
    ...rest,
    ...command.target,
    providerHandleChain: head
      ? [
          ...record.providerHandleChain.slice(0, -1),
          {
            ...head,
            seenThrough: command.through,
            accountHome: launchedAccount?.accountHome ?? accountHome
          }
        ]
      : record.providerHandleChain,
    providerSwitch: {
      clientMessageId: command.clientMessageId,
      through: command.through,
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
    return { ...rest, updatedAt: command.now }
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
    ...previous
  } = rest
  const through = record.providerHandleChain.findIndex(
    ({ linkId }) => linkId === providerSwitch.fromLinkId
  )
  return {
    ...previous,
    ...providerSwitch.from,
    providerHandleChain: record.providerHandleChain.slice(0, through + 1),
    lease: { ...record.lease, provenHandleLinkId: null },
    updatedAt: command.now
  }
}
