import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { describeTerminalWaitBlockedReason } from '../../../../shared/terminal/runtime-policy/terminal-wait-blocked-reason-legacy-alias'
import type { OrcaRuntimeService } from '../../orca-runtime'

const CLAUDE_BYPASS_WARNING_RE = /running\s*in\s*bypass\s*permissions\s*mode/

export const CLAUDE_BYPASS_WARNING_HINT =
  "Claude is asking to confirm Bypass Permissions mode, which this host's Full access permission turns on. " +
  'Accept it once in that terminal, or set this host\'s Settings > Agents > Permissions to "Each agent\'s own settings".'

/** Keeps the parsed `Agent startup blocked: <reason>` prefix, then names the dialog when it is one the user can fix in Settings. */
export async function agentStartupBlockedMessage(
  runtime: Pick<OrcaRuntimeService, 'readTerminal'>,
  handle: string,
  reason: RuntimeTerminalWaitBlockedReason
): Promise<string> {
  const message = `Agent startup blocked: ${describeTerminalWaitBlockedReason(reason)}`
  if (reason !== 'agent-startup-menu-prompt') {
    return message
  }
  // The pane may already be gone; the bare reason is still the right failure.
  const screen = await Promise.resolve()
    .then(() => runtime.readTerminal(handle, { screen: true }))
    .then((read) => read.tail.join('\n').toLowerCase())
    .catch(() => '')
  return CLAUDE_BYPASS_WARNING_RE.test(screen)
    ? `${message}. ${CLAUDE_BYPASS_WARNING_HINT}`
    : message
}
