import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress-intent'
import { normalizeColorQueryReplyColors } from '../../shared/pty-owner-color-query-colors'
import { recognizeAgentLaunchCommand } from '../../shared/agent-command-line-intent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { agentKindSchema } from '../../shared/telemetry-events'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'

function isAgentLaunch(args: {
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
  return recognizeAgentLaunchCommand(command) !== null
}

// jcode queries before TUI input is ready; suppress cooked replies via agent, telemetry kind or quick-launch command.
export function agentSkipsStartupOscColorQueryReplies(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  if (args.launchAgent === 'jcode' || args.telemetry?.agent_kind === 'jcode') {
    return true
  }
  const command = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  return command.length > 0 && recognizeAgentLaunchCommand(command)?.agent === 'jcode'
}

export function getStartupTerminalIngressIntent(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  terminalColorQueryReplies?: unknown
  launcherColorQueryReplies?: unknown
  launcherViewAttributes?: unknown
  terminalKittyKeyboardProtocol?: boolean
}) {
  const skipColors = agentSkipsStartupOscColorQueryReplies(args)
  // Seed every PTY: agents launched later from plain shells can also query before viewer colors arrive.
  const colors = skipColors
    ? {}
    : (normalizeColorQueryReplyColors(args.terminalColorQueryReplies) ?? {})
  const launcherColors = skipColors
    ? null
    : normalizeColorQueryReplyColors(args.launcherColorQueryReplies)
  return parsePtyStartupIngressIntent({
    kittyKeyboardProtocol: args.terminalKittyKeyboardProtocol === true && isAgentLaunch(args),
    colors,
    ...(launcherColors ? { launcherColors, launcherAttributes: args.launcherViewAttributes } : {}),
    deadlineMs: 5_000
  })
}
