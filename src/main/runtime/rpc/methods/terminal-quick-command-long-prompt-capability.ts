// Transitional: remove once no supported release lacks TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY.
//
// A client from before long prompts rejects the whole quick-command list if one prompt is longer
// than its old cap, so the host leaves those commands out of what it publishes to that client.
// Omitting beats trimming: a trimmed copy would run the wrong prompt, and saving it would
// overwrite the stored one.

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
