import { parseNormalizedTerminalQuickCommands } from '../terminal/quick-commands'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type {
  HostSessionQuickCommandOperations,
  HostSessionQuickCommandSnapshot
} from './host-session-quick-command-operations'

const LOAD_CUTOVER_MAX_RETRIES = 5

export function nativeHostSessionQuickCommandOperations(
  client: RpcClient
): HostSessionQuickCommandOperations {
  return {
    async snapshot(signal) {
      // The ok check sits outside the retry, as it did before this seam existed: a refusal
      // envelope is an answer, and replaying it would depend on the host's error text.
      const response = await loadWithCutoverRetry(client, signal)
      if (!response.ok) {
        throw new Error(response.error.message || 'Failed to load quick commands')
      }
      return quickCommandSnapshot(response.result, 'Failed to load quick commands')
    },
    async mutate(mutation) {
      // Why no cutover retry here: a quick-command mutation is not idempotent, so a replay
      // after a logical cutover could apply the same edit twice.
      const response = await client.sendRequest('settings.updateTerminalQuickCommands', {
        mutation
      })
      if (!response.ok) {
        throw new Error(response.error.message || 'Failed to save quick command')
      }
      return quickCommandSnapshot(response.result, 'Failed to save quick command')
    }
  }
}

async function loadWithCutoverRetry(client: RpcClient, signal?: AbortSignal) {
  for (let retry = 0; ; retry += 1) {
    try {
      return await client.sendRequest('settings.getTerminalQuickCommands')
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
  invalidResultMessage: string
): HostSessionQuickCommandSnapshot {
  const commands = parseNormalizedTerminalQuickCommands(
    (result as { terminalQuickCommands?: unknown } | null)?.terminalQuickCommands
  )
  if (!commands) {
    throw new Error(invalidResultMessage)
  }
  return { commands }
}
