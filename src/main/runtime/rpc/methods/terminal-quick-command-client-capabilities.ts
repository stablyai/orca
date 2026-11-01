import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  applyTerminalQuickCommandMutation,
  type TerminalQuickCommandMutation
} from '../../../../shared/terminal-quick-commands'
import { isLegacyReadableTerminalQuickCommand } from '../../../../shared/terminal-quick-command-prompt-limit'
import {
  LEGACY_MAX_QUICK_COMMANDS,
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
} from '../../../../shared/terminal-quick-command-capabilities'
import { InvalidArgumentError, type RpcContext } from '../core'

type QuickCommandReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

export function projectTerminalQuickCommandsForClient(
  commands: TerminalQuickCommand[],
  ctx: QuickCommandReader
): TerminalQuickCommand[] {
  if (ctx.clientKind === undefined) {
    return commands
  }
  const readable = ctx.clientCapabilities?.includes(
    TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
  )
    ? commands
    : commands.filter(isLegacyReadableTerminalQuickCommand)
  return ctx.clientCapabilities?.includes(TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY)
    ? readable
    : readable.slice(0, LEGACY_MAX_QUICK_COMMANDS)
}

export function assertTerminalQuickCommandMutationReadableForClient(
  commands: TerminalQuickCommand[],
  mutation: TerminalQuickCommandMutation,
  ctx: QuickCommandReader
): void {
  if (mutation.type === 'delete') {
    return
  }
  const existing = commands.find((command) => command.id === mutation.command.id)
  const next = applyTerminalQuickCommandMutation(commands, mutation)
  if (
    (existing &&
      !projectTerminalQuickCommandsForClient(commands, ctx).some(
        (command) => command.id === existing.id
      )) ||
    !projectTerminalQuickCommandsForClient(next, ctx).some(
      (command) => command.id === mutation.command.id
    )
  ) {
    throw new InvalidArgumentError(
      'Update this Orca client to save this quick command. This version cannot display it in the saved list.'
    )
  }
}
