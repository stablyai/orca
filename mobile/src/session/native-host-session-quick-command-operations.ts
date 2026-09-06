import {
  parseNormalizedTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../terminal/quick-commands'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type {
  HostSessionQuickCommandOperations,
  HostSessionQuickCommandSnapshot
} from './host-session-quick-command-operations'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'

const LOAD_CUTOVER_MAX_RETRIES = 5

export function nativeHostSessionQuickCommandOperations(
  client: RpcClient
): HostSessionQuickCommandOperations {
  return {
    async snapshot(workspaceId, signal) {
      return quickCommandSnapshot(
        await quickCommandRequest(client, 'settings.getTerminalQuickCommands', undefined, signal),
        workspaceId,
        'Failed to load quick commands'
      )
    },
    async mutate(workspaceId, mutation) {
      return quickCommandSnapshot(
        await quickCommandRequest(client, 'settings.updateTerminalQuickCommands', {
          mutation
        }),
        workspaceId,
        'Failed to save quick command'
      )
    }
  }
}

async function quickCommandRequest(
  client: RpcClient,
  method: 'settings.getTerminalQuickCommands' | 'settings.updateTerminalQuickCommands',
  params?: { mutation: TerminalQuickCommandMutation },
  signal?: AbortSignal
) {
  for (let retry = 0; ; retry += 1) {
    try {
      const response = params
        ? await client.sendRequest(method, params)
        : await client.sendRequest(method)
      if (!response.ok) {
        throw new Error(response.error.message || 'quick_commands_failed')
      }
      return response.result
    } catch (error) {
      if (
        signal?.aborted ||
        !isLogicalClientCutoverError(error) ||
        retry >= LOAD_CUTOVER_MAX_RETRIES
      ) {
        throw error
      }
    }
  }
}

function quickCommandSnapshot(
  result: unknown,
  workspaceId: string,
  invalidResultMessage: string
): HostSessionQuickCommandSnapshot {
  const commands = parseNormalizedTerminalQuickCommands(
    (result as { terminalQuickCommands?: unknown } | null)?.terminalQuickCommands
  )
  if (!commands) {
    throw new Error(invalidResultMessage)
  }
  return {
    commands,
    totalCount: commands.length,
    repoId:
      workspaceId.startsWith('folder:') || isFloatingWorkspaceWorktreeId(workspaceId)
        ? null
        : getRepoIdFromMobileWorktreeId(workspaceId)
  }
}
