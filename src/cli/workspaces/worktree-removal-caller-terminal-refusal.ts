import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import type { RuntimeTerminalShow } from '../../shared/terminal/runtime/runtime-terminal-contracts'
import { RuntimeClientError } from '../runtime/connection/types'

type CallerTerminal = Pick<RuntimeTerminalShow, 'worktreeId' | 'executionHostId'>

/** The slice of RuntimeClient this check needs. */
type TerminalShowClient = {
  readonly isRemote: boolean
  call(
    method: 'terminal.show',
    params: { terminal: string }
  ): Promise<{ result: { terminal: CallerTerminal } }>
}

type RemovalTarget = { id: string; path?: string; hostId?: ExecutionHostId }

// The handle names no live terminal here, so removal cannot stop it.
const NO_TERMINAL_CODES = new Set([
  'terminal_handle_stale',
  'terminal_gone',
  'terminal_not_found',
  'terminal_unsupported_for_agent_session'
])

/**
 * Removal stops every terminal the workspace owns before deleting it, so a command issued from one
 * of them is killed before it can report anything (#47665). Refuse instead of stopping the caller.
 */
export async function refuseRemovalFromOwnTerminal(
  client: TerminalShowClient,
  target: RemovalTarget,
  callerHandle: string | undefined = process.env.ORCA_TERMINAL_HANDLE
): Promise<void> {
  // The handle names a terminal of this machine's Orca; another environment never owns it.
  if (!callerHandle || client.isRemote) {
    return
  }
  const terminal = await showCallerTerminal(client, callerHandle)
  if (!terminal || !isSameWorkspace(terminal, target)) {
    return
  }
  throw new RuntimeClientError(
    'caller_terminal_in_target_workspace',
    `orca worktree rm would stop the terminal running it (${callerHandle}): that terminal belongs to the workspace being removed, ${target.path ?? target.id}. Nothing was removed.`,
    {
      callerTerminal: callerHandle,
      worktreeId: target.id,
      nextSteps: ['Run the same command from a terminal in another workspace.']
    }
  )
}

function isSameWorkspace(terminal: CallerTerminal, target: RemovalTarget): boolean {
  // Worktree ids are path-derived, so two hosts can share one; the host tells them apart.
  const hostsDiffer =
    terminal.executionHostId !== undefined &&
    target.hostId !== undefined &&
    terminal.executionHostId !== target.hostId
  return terminal.worktreeId === target.id && !hostsDiffer
}

async function showCallerTerminal(
  client: TerminalShowClient,
  handle: string
): Promise<CallerTerminal | undefined> {
  try {
    return (await client.call('terminal.show', { terminal: handle })).result.terminal
  } catch (error) {
    if (
      error instanceof RuntimeClientError &&
      (NO_TERMINAL_CODES.has(error.code) || NO_TERMINAL_CODES.has(error.message))
    ) {
      return undefined
    }
    throw error
  }
}
