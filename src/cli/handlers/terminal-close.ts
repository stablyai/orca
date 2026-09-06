import type {
  RuntimeTerminalClose,
  RuntimeWorktreeTerminalCloseResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatTerminalClose, reportCliError, printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector, getTerminalHandle } from '../selectors'

/** A false stop receipt is an error only when the host supplied a liveness verdict. */
function terminalCloseFailure(close: RuntimeTerminalClose): RuntimeClientError | null {
  if (close.ptyKilled || close.ptyStopVerdict === undefined) {
    return null
  }

  const verdict = close.ptyStopVerdict
  const detail =
    verdict === 'live'
      ? 'The PTY is live.'
      : `The PTY was not confirmed stopped: ${close.ptyStopReason ?? 'its host could not be reached'}.`
  return new RuntimeClientError(
    verdict === 'live' ? 'terminal_stop_live' : 'terminal_stop_unverifiable',
    `Terminal ${close.handle} close failed to confirm the PTY stopped (${verdict}). ${detail}`,
    { close }
  )
}

function terminalCloseAllFailure(
  close: RuntimeWorktreeTerminalCloseResult
): RuntimeClientError | null {
  if (!close.ptyStopVerdict) {
    return null
  }
  const detail =
    close.ptyStopVerdict === 'live'
      ? 'At least one PTY is live.'
      : `At least one PTY was not confirmed stopped: ${close.ptyStopReason ?? 'its owning host could not be reached'}.`
  return new RuntimeClientError(
    close.ptyStopVerdict === 'live' ? 'terminal_stop_live' : 'terminal_stop_unverifiable',
    `Workspace terminal close did not confirm every PTY stopped (${close.ptyStopVerdict}). ${detail}`,
    { close }
  )
}

export const terminalCloseHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  if (flags.get('all') === true) {
    if (flags.has('terminal') || flags.get('tab') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--all uses --worktree and cannot be combined with --terminal or --tab'
      )
    }
    try {
      const result = await client.call<RuntimeWorktreeTerminalCloseResult>('terminal.closeAll', {
        worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
      })
      const failure = terminalCloseAllFailure(result.result)
      if (failure) {
        reportCliError(failure, json)
        process.exitCode = 1
        return
      }
      printResult(
        result,
        json,
        (value) =>
          `Closed ${value.closed} terminal tabs and stopped ${value.stopped} terminal processes.`
      )
      return
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'This Orca host does not support closing every terminal in a workspace yet. Update Orca on the host and try again.'
        )
      }
      throw error
    }
  }
  if (flags.has('worktree')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Closing a workspace requires --all: terminal close --worktree <selector> --all'
    )
  }
  const method = flags.get('tab') === true ? 'terminal.closeTab' : 'terminal.close'
  const result = await client.call<{ close: RuntimeTerminalClose }>(method, {
    terminal: await getTerminalHandle(flags, cwd, client)
  })
  // Why: a transport-level success must not hide a live or unverifiable PTY. Keep the receipt in
  // error.data so JSON callers retain the host's exact evidence while receiving a failing outcome.
  const failure = terminalCloseFailure(result.result.close)
  if (failure) {
    // Keep the established human receipt (including its liveness warning); JSON needs the
    // standard failure envelope so callers do not mistake transport success for a stopped PTY.
    if (json) {
      reportCliError(failure, true)
    } else {
      printResult(result, false, formatTerminalClose)
    }
    process.exitCode = 1
    return
  }
  printResult(result, json, formatTerminalClose)
}
