import type { TerminalLimitStatus } from '../../../shared/terminal/runtime-policy/terminal-limit-policy'
import { terminalUsageNotice } from '../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import type { RuntimeClient } from '../client'

const LIMIT_READ_TIMEOUT_MS = 3_000

/** Terminals in use near the cap; omitted below it, and when the runtime can't say. */
export async function readStatusTerminalUsage(
  client: Pick<RuntimeClient, 'call'>
): Promise<string | undefined> {
  try {
    const response = await client.call<TerminalLimitStatus | null>(
      'terminalDaemon.limit',
      undefined,
      { timeoutMs: LIMIT_READ_TIMEOUT_MS }
    )
    return terminalUsageNotice(response.result)
  } catch {
    return undefined
  }
}
