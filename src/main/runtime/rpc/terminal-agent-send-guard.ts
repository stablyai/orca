import type { OrcaRuntimeService } from '../orca-runtime'

const AGENT_STATUS_RECHECK_INTERVAL_MS = 150
const AGENT_STATUS_RECHECK_TIMEOUT_MS = 1_050
const AGENT_STATUS_FINAL_PROBE_TIMEOUT_MS = 1_050

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
        throw new Error('terminal_guard_not_writable')
      }
      throw error
    }
    options.assertWritable()
    if (agentStatus.isRunningAgent) {
      if (agentStatus.status === 'permission') {
        throw new Error('terminal_guard_permission')
      }
      return
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      // Why: pre-v11 daemon / transport inspect returns unavailable:true while
      // getForegroundProcess is still null — same as "no agent" until we split
      // the guard error so callers can offer "send anyway" (#12946).
      if (await isTerminalForegroundStatusUnavailableWithinLimit(options)) {
        throw new Error('terminal_guard_status_unavailable')
      }
      throw new Error('terminal_guard_no_agent')
    }
    // Why: title and foreground caches refresh asynchronously; require fresh
    // positive evidence within a wall-clock bound so slow SSH reads cannot multiply it.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(AGENT_STATUS_RECHECK_INTERVAL_MS, remainingMs))
    )
  }
}

async function isTerminalForegroundStatusUnavailableWithinLimit(
  options: AssertTerminalAgentSendableOptions
): Promise<boolean> {
  const inspect = options.runtime.isTerminalForegroundStatusUnavailable
  if (!inspect) {
    return false
  }
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      inspect.call(options.runtime, options.handle),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(true), AGENT_STATUS_FINAL_PROBE_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
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
