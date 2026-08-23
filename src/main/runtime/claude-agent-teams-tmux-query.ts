import {
  parseTmuxArgs,
  renderTmuxFormat,
  tmuxValue
} from '../../shared/claude-agent-teams-tmux-compat'
import { formatContext, resolvePane, resolvePaneOrWindow } from './claude-agent-teams-pane-layout'
import type { AgentTeam } from './claude-agent-teams-types'

export function showTmuxOption(args: string[]): string {
  const parsed = parseTmuxArgs(args, ['-t'], ['-g', '-q', '-s', '-v', '-w'])
  const optionName = parsed.positional.at(-1) ?? ''
  if (optionName !== 'extended-keys') {
    throw new Error(`unsupported option: ${optionName}`)
  }
  return parsed.flags.has('-v') ? 'on\n' : 'extended-keys on\n'
}

export function displayTmuxMessage(team: AgentTeam, args: string[], envPane: string): string {
  const parsed = parseTmuxArgs(args, ['-F', '-t'], ['-p'])
  const target = resolvePaneOrWindow(team, tmuxValue(parsed, '-t') ?? envPane)
  const pane = target.type === 'window' ? resolvePane(team, envPane) : target.pane
  const format =
    parsed.positional.length > 0 ? parsed.positional.join(' ') : tmuxValue(parsed, '-F')
  return `${renderTmuxFormat(format, formatContext(team, pane), '')}\n`
}
