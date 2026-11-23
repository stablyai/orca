import { terminalUsageNotice } from '../../../../../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { withTimeout } from '../../../../../../../shared/concurrency/promise-timeout-fallback'

// An in-memory answer; a daemon slower than this must not hold up a started worker's receipt.
const USAGE_READ_TIMEOUT_MS = 1_000

/** Near the cap, the receipt says how many terminals this computer uses, so its agent can tell the user. */
export async function withTerminalUsage(
  runtime: OrcaRuntimeService,
  receipt: unknown
): Promise<unknown> {
  if (!receipt || typeof receipt !== 'object') {
    return receipt
  }
  const usage = await withTimeout(runtime.hostTerminalUsage(), USAGE_READ_TIMEOUT_MS, null)
  const terminals = terminalUsageNotice(usage)
  return terminals ? { ...receipt, terminals } : receipt
}
