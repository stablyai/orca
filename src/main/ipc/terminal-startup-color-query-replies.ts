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

// Why: jcode paints its own theme and fires its OSC 10/11 burst before its TUI
// input loop is ready, so the cooked reply (`10;rgb:…`) lands in the composer as
// pre-typed text (same class as #12112, which fixed opencode).
//
// Why all three signals and not just launchAgent: a pane can name jcode through the
// telemetry kind or the command alone (a `jcode` quick-launch carries no launchAgent),
// and those panes leak exactly the same composer text.
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
  return command.length > 0 && recognizeAgentProcessFromCommandLine(command)?.agent === 'jcode'
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
  const colors = agentSkipsStartupOscColorQueryReplies(args)
    ? {}
    : (normalizeColorQueryReplyColors(args.terminalColorQueryReplies) ?? {})
  return parsePtyStartupIngressIntent({
    kittyKeyboardProtocol: args.terminalKittyKeyboardProtocol === true && isAgentLaunch(args),
    colors,
    deadlineMs: 5_000
  })
}
