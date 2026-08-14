import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { agentKindSchema } from '../../shared/telemetry-events'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import {
  parseTerminalOscColorQueryReplyColors,
  type TerminalOscColorQueryReplyColors
} from '../../shared/terminal-osc-color-reply'

function shouldReplyToStartupTerminalColorQueries(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  if (isTuiAgent(args.launchAgent)) {
    return true
  }
  const agentKindParse =
    args.telemetry?.agent_kind !== undefined
      ? agentKindSchema.safeParse(args.telemetry.agent_kind)
      : null
  if (agentKindParse?.success && agentKindParse.data !== 'other') {
    return true
  }
  const command = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  return recognizeAgentProcessFromCommandLine(command) !== null
}

export function getStartupTerminalColorQueryReplyColors(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  terminalColorQueryReplies?: unknown
}): TerminalOscColorQueryReplyColors | null {
  if (!shouldReplyToStartupTerminalColorQueries(args)) {
    return null
  }
  return parseTerminalOscColorQueryReplyColors(args.terminalColorQueryReplies) ?? null
}

export function getLiveTerminalOscColorQueryReplyColors(args: {
  terminalColorQueryReplies?: unknown
}): TerminalOscColorQueryReplyColors | null {
  return parseTerminalOscColorQueryReplyColors(args.terminalColorQueryReplies) ?? null
}
