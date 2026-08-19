import type { RuntimeTerminalListResult } from '../shared/runtime-types'
import { getPtyExecutionHost } from '../shared/terminal-execution-host'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

const listCachedTerminal = (
  client: RuntimeClient,
  ptyId: string
): Promise<{ result: RuntimeTerminalListResult }> =>
  client.call<RuntimeTerminalListResult>('terminal.list', {
    limit: 200,
    ptyId,
    includeVisualLayouts: false
  })

export async function resolveTerminalSelector(
  selector: string,
  client: RuntimeClient
): Promise<string> {
  const trimmed = selector.trim()
  if (!trimmed.toLowerCase().startsWith('pty:')) {
    return trimmed
  }
  const ptyId = trimmed.slice(trimmed.indexOf(':') + 1).trim()
  if (!ptyId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Empty pty id after pty:. Use a ptyId from `orca terminal list --json`.'
    )
  }
  let listed: { result: RuntimeTerminalListResult }
  try {
    listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
      limit: 200,
      ptyId,
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'terminal_liveness_unavailable') {
      throw error
    }
    listed = await listCachedTerminal(client, ptyId)
  }
  let match = listed.result.terminals.find(
    (terminal) => terminal.ptyId === ptyId && terminal.connected
  )
  const targetHost = getPtyExecutionHost(ptyId)
  if (
    !match &&
    targetHost &&
    targetHost !== 'foreign' &&
    listed.result.hostScope?.omittedHostIds.includes(targetHost)
  ) {
    listed = await listCachedTerminal(client, ptyId)
    match = listed.result.terminals.find(
      (terminal) => terminal.ptyId === ptyId && terminal.connected
    )
  }
  if (!match) {
    if (listed.result.truncated) {
      const total = listed.result.totalCount ?? listed.result.terminals.length
      throw new RuntimeClientError(
        'terminal_not_found',
        `No terminal with ptyId ${ptyId} in the first ${listed.result.terminals.length} of ${total} terminals (list truncated). Upgrade the host, or re-list with a worktree filter and pass the resulting handle.`
      )
    }
    throw new RuntimeClientError(
      'terminal_not_found',
      `No live terminal with ptyId ${ptyId}. Re-run terminal list after restart or rehydration.`
    )
  }
  return match.handle
}
