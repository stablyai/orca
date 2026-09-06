import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import {
  parseNormalizedTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../terminal/quick-commands'
import {
  explicitQuickCommandScope,
  type HostSessionQuickCommandOperations,
  type HostSessionQuickCommandSnapshot
} from './host-session-quick-command-operations'

export function webHostSessionQuickCommandOperations(
  client: MobileWebBridgeClient
): HostSessionQuickCommandOperations {
  return {
    snapshot(workspaceId) {
      return client.sessionQuickCommands({ workspaceId }).then(webQuickCommandSnapshot)
    },
    mutate(workspaceId, mutation) {
      return client
        .sessionQuickCommandMutate({
          workspaceId,
          mutation: webQuickCommandMutation(mutation)
        })
        .then(webQuickCommandSnapshot)
    }
  }
}

function webQuickCommandMutation(
  mutation: TerminalQuickCommandMutation
): Parameters<MobileWebBridgeClient['sessionQuickCommandMutate']>[0]['mutation'] {
  if (mutation.type === 'delete') {
    return mutation
  }
  const command = mutation.command
  return command.action === 'agent-prompt'
    ? {
        type: 'upsert',
        command: {
          ...command,
          scope: explicitQuickCommandScope(command.scope)
        }
      }
    : {
        type: 'upsert',
        command: {
          ...command,
          action: 'terminal-command',
          scope: explicitQuickCommandScope(command.scope)
        }
      }
}

function webQuickCommandSnapshot(result: {
  commands: unknown
  totalCount: number
  repoId: string | null
}): HostSessionQuickCommandSnapshot {
  const commands = parseNormalizedTerminalQuickCommands(result.commands)
  if (!commands) {
    throw new Error('quick_commands_failed')
  }
  return { commands, totalCount: result.totalCount, repoId: result.repoId }
}
