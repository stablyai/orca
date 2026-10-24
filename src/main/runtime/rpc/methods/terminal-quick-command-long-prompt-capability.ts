// Remove once every supported release has TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY.
// Older clients reject lists containing long prompts; omit those commands rather than trim and run/save different text.

import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { isLegacyReadableTerminalQuickCommand } from '../../../../shared/terminal-quick-command-prompt-limit'
import { TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY } from '../../../../shared/terminal-quick-command-capabilities'
import type { RpcContext } from '../core'

type QuickCommandReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function readsLongPrompts(ctx: QuickCommandReader): boolean {
  // An in-process caller is this build; only a negotiated client can predate long prompts.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY) ===
      true
  )
}

export function projectTerminalQuickCommandsForClient(
  commands: TerminalQuickCommand[],
  ctx: QuickCommandReader
): TerminalQuickCommand[] {
  if (readsLongPrompts(ctx) || commands.every(isLegacyReadableTerminalQuickCommand)) {
    return commands
  }
  return commands.filter(isLegacyReadableTerminalQuickCommand)
}
