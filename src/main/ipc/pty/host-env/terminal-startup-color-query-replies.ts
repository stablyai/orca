import { parsePtyStartupIngressIntent } from '../../../../shared/terminal/pty/ingress/pty-startup-ingress-intent'
import { normalizeColorQueryReplyColors } from '../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import { recognizeAgentLaunchCommand } from '../../../../shared/agent-launch/startup/agent-command-line-intent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { agentKindSchema } from '../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

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

// jcode and agy paint an early OSC 10/11 reply as composer text (#12112, #51192).
export function agentSkipsStartupOscColorQueryReplies(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  if (
    args.launchAgent === 'jcode' ||
    args.launchAgent === 'antigravity' ||
    args.telemetry?.agent_kind === 'jcode' ||
    args.telemetry?.agent_kind === 'antigravity'
  ) {
    return true
  }
  const command = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  const agent = command.length > 0 ? recognizeAgentLaunchCommand(command)?.agent : undefined
  return agent === 'jcode' || agent === 'antigravity'
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
