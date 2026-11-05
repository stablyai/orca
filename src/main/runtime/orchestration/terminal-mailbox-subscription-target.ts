import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { orchestrationCompatibilityHostScopesEqual } from '../orchestration-compatibility-host-scope'
import type { CurrentTerminalMailboxAuthority } from './terminal-mailbox-subscriptions'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'

/** Only an exact attested receiver binding can use the runtime's canonical terminal. */
export function resolveTerminalMailboxSubscriptionTerminal(input: {
  binding: CurrentTerminalMailboxAuthority
  current: CurrentTerminalMailboxAuthority | null
  terminal: OrchestrationMailboxTerminal | null
}): OrchestrationMailboxTerminal | null {
  const { binding, current, terminal } = input
  return parsePaneKey(binding.paneKey) &&
    current &&
    current.terminalHandle === binding.terminalHandle &&
    current.paneKey === binding.paneKey &&
    current.ptyId === binding.ptyId &&
    current.processIncarnation === binding.processIncarnation &&
    orchestrationCompatibilityHostScopesEqual(current.hostScope, binding.hostScope) &&
    terminal?.handle === binding.terminalHandle &&
    terminal.ptyId === binding.ptyId &&
    terminal.paneKeys.length === 1 &&
    terminal.paneKeys[0] === binding.paneKey
    ? terminal
    : null
}
