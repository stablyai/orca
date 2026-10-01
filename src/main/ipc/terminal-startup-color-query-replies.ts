import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress-intent'
import { normalizeColorQueryReplyColors } from '../../shared/pty-owner-color-query-colors'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
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
  return recognizeAgentProcessFromCommandLine(command) !== null
}

export function getStartupTerminalIngressIntent(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  terminalColorQueryReplies?: unknown
  terminalKittyKeyboardProtocol?: boolean
}) {
  // Why colours for every PTY: an agent typed into a plain shell later queries too, and these
  // seed an owner that has not been pushed the host's viewer colours yet.
  return parsePtyStartupIngressIntent({
    colors: normalizeColorQueryReplyColors(args.terminalColorQueryReplies) ?? {},
    kittyKeyboardProtocol: args.terminalKittyKeyboardProtocol === true && isAgentLaunch(args),
    deadlineMs: 5_000
  })
}
