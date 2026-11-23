import { terminalUsageNotice } from '../../../../../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'

/** Near the cap, the receipt says how many terminals this computer uses, so its agent can tell the user. */
export async function withTerminalUsage(
  runtime: OrcaRuntimeService,
  receipt: unknown
): Promise<unknown> {
  if (!receipt || typeof receipt !== 'object') {
    return receipt
  }
  const terminals = terminalUsageNotice(await runtime.hostTerminalUsage().catch(() => null))
  return terminals ? { ...receipt, terminals } : receipt
}
