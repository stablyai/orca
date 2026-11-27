import {
  TERMINAL_HOST_CAP_CODE,
  terminalUsageNotice
} from '../../../../../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import type { HostTerminalUsage } from '../../../../../../../shared/terminal/runtime-policy/terminal-limit-policy'

type SpawnUsageReader = { getSpawnHostTerminalUsage(handle: string): HostTerminalUsage | undefined }

/** The agent terminal this start opened; a reused one's spawn belongs to an earlier start. */
function createdAgentTerminal(effects: unknown): string | undefined {
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (
      typeof effect === 'object' &&
      effect !== null &&
      effect.kind === 'terminal' &&
      effect.role === 'agent' &&
      effect.action === 'created' &&
      typeof effect.id === 'string'
    ) {
      return effect.id
    }
  }
  return undefined
}

/** Near the cap, the receipt says how many terminals the worker's host uses, as that start's own
 *  spawn reported them, so its agent can tell the user. A refusal at the cap already says so. */
export function withTerminalUsage(runtime: SpawnUsageReader, receipt: unknown): unknown {
  if (!receipt || typeof receipt !== 'object') {
    return receipt
  }
  if ('blockedReason' in receipt && receipt.blockedReason === TERMINAL_HOST_CAP_CODE) {
    return receipt
  }
  const handle = createdAgentTerminal('effects' in receipt ? receipt.effects : undefined)
  const terminals = terminalUsageNotice(
    handle ? runtime.getSpawnHostTerminalUsage(handle) : undefined
  )
  return terminals ? { ...receipt, terminals } : receipt
}
