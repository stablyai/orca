import {
  getTerminalQuickCommandBody,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand
} from '../shared/terminal-quick-commands'
import type {
  RuntimeQuickCommandList,
  RuntimeQuickCommandMutation,
  RuntimeQuickCommandRemoval,
  RuntimeQuickCommandShow
} from '../shared/runtime-types'
import type { TerminalQuickCommand } from '../shared/terminal-quick-command-types'

function formatScope(command: TerminalQuickCommand): string {
  const scope = getTerminalQuickCommandScope(command)
  return scope.type === 'global' ? 'global' : `repo:${scope.repoId}`
}

function formatSingleLineBody(command: TerminalQuickCommand): string {
  return getTerminalQuickCommandBody(command).replace(/\s*\r?\n\s*/g, ' ⏎ ')
}

function formatRow(command: TerminalQuickCommand): string {
  const kind = isTerminalAgentQuickCommand(command)
    ? `agent-prompt(${command.agent})`
    : command.appendEnter
      ? 'terminal-command'
      : 'terminal-command(no-enter)'
  return [
    `${command.id}  ${command.label || '(untitled)'}`,
    `  scope: ${formatScope(command)}  action: ${kind}`,
    `  body: ${formatSingleLineBody(command)}`
  ].join('\n')
}

export function formatQuickCommandList(result: RuntimeQuickCommandList): string {
  if (result.quickCommands.length === 0) {
    return 'No quick commands'
  }
  return result.quickCommands.map(formatRow).join('\n\n')
}

export function formatQuickCommandShow(
  result: RuntimeQuickCommandShow | RuntimeQuickCommandMutation
): string {
  return formatRow(result.quickCommand)
}

export function formatQuickCommandRemoval(result: RuntimeQuickCommandRemoval): string {
  return `Removed ${result.removed.id} (${result.removed.label || 'untitled'})`
}
