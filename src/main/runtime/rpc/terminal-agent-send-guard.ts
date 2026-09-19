import type { OrcaRuntimeService } from '../orca-runtime'

const AGENT_STATUS_RECHECK_INTERVAL_MS = 150
const AGENT_STATUS_RECHECK_TIMEOUT_MS = 1_050

/** Exported so callers match a constant: a bare literal elsewhere compiles clean
 *  after a rename here and silently stops matching. */
export const TERMINAL_GUARD_PERMISSION = 'terminal_guard_permission'
export const TERMINAL_GUARD_NO_AGENT = 'terminal_guard_no_agent'
export const TERMINAL_GUARD_NOT_WRITABLE = 'terminal_guard_not_writable'

export type TerminalSendGuardRefusedReason = 'no-agent' | 'permission'

/** Classify a guard rejection. `undefined` means the error came from somewhere
 *  else and the caller should treat it as an unexpected failure. */
export function getTerminalSendGuardRefusedReason(
  error: unknown
): TerminalSendGuardRefusedReason | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(TERMINAL_GUARD_PERMISSION)) {
    return 'permission'
  }
  if (message.includes(TERMINAL_GUARD_NO_AGENT)) {
    return 'no-agent'
  }
  return undefined
}

export function isTerminalSendGuardNotWritable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(TERMINAL_GUARD_NOT_WRITABLE)
}

type AssertTerminalAgentSendableOptions = {
  runtime: OrcaRuntimeService
  handle: string
  assertWritable: () => void
}

export async function assertTerminalAgentSendable(
  options: AssertTerminalAgentSendableOptions
): Promise<void> {
  const deadline = Date.now() + AGENT_STATUS_RECHECK_TIMEOUT_MS
  while (true) {
    options.assertWritable()
    let agentStatus
    try {
      agentStatus = await options.runtime.getTerminalAgentStatus(options.handle)
    } catch (error) {
      if (isTerminalAgentStatusNotWritable(error)) {
        throw new Error(TERMINAL_GUARD_NOT_WRITABLE)
      }
      throw error
    }
    options.assertWritable()
    if (agentStatus.isRunningAgent) {
      if (agentStatus.status === 'permission') {
        throw new Error(TERMINAL_GUARD_PERMISSION)
      }
      return
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(TERMINAL_GUARD_NO_AGENT)
    }
    // Why: title and foreground caches refresh asynchronously; require fresh
    // positive evidence within a wall-clock bound so slow SSH reads cannot multiply it.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(AGENT_STATUS_RECHECK_INTERVAL_MS, remainingMs))
    )
  }
}

function isTerminalAgentStatusNotWritable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    'terminal_not_writable',
    'terminal_handle_stale',
    'terminal_gone',
    'terminal_exited'
  ].some((code) => message.includes(code))
}
