import type { TerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import {
  applyTerminalQuickCommandMutation,
  withoutCloseTabOnSuccess,
  type TerminalQuickCommandMutation
} from '../../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { isLegacyReadableTerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import {
  LEGACY_MAX_QUICK_COMMANDS,
  TERMINAL_QUICK_COMMAND_CLOSE_TAB_ON_SUCCESS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
} from '../../../../../shared/terminal/quick-commands/terminal-quick-command-capabilities'
import { InvalidArgumentError, type RpcContext } from '../../core'

type QuickCommandReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

export function projectTerminalQuickCommandsForClient(
  commands: TerminalQuickCommand[],
  ctx: QuickCommandReader
): TerminalQuickCommand[] {
  if (ctx.clientKind === undefined) {
    return commands
  }
  const readable = (
    ctx.clientCapabilities?.includes(TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY)
      ? commands
      : commands.filter(isLegacyReadableTerminalQuickCommand)
  ).map((command) =>
    ctx.clientCapabilities?.includes(TERMINAL_QUICK_COMMAND_CLOSE_TAB_ON_SUCCESS_RUNTIME_CAPABILITY)
      ? command
      : withoutCloseTabOnSuccess(command)
  )
  return ctx.clientCapabilities?.includes(TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY)
    ? readable
    : readable.slice(0, LEGACY_MAX_QUICK_COMMANDS)
}

// Clients without the capability never see the flag, so their edits must keep the stored value.
export function keepCloseTabOnSuccessForClient(
  commands: TerminalQuickCommand[],
  mutation: TerminalQuickCommandMutation,
  ctx: QuickCommandReader
): TerminalQuickCommandMutation {
  if (
    mutation.type === 'delete' ||
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(
      TERMINAL_QUICK_COMMAND_CLOSE_TAB_ON_SUCCESS_RUNTIME_CAPABILITY
    ) ||
    mutation.command.action === 'agent-prompt'
  ) {
    return mutation
  }
  const existing = commands.find((command) => command.id === mutation.command.id)
  return existing && 'closeTabOnSuccess' in existing
    ? { ...mutation, command: { ...mutation.command, closeTabOnSuccess: true } }
    : mutation
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
