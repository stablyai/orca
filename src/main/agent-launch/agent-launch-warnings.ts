import type { AgentLaunchIntent } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING } from '../../shared/agent-launch/startup/agent-launch-account-env'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import { terminalLaunchChatModel } from './agent-launch-surface-factories'

export function combineLaunchWarnings(
  create: string | undefined,
  surface: string | undefined
): string | undefined {
  if (!create || !surface) {
    return create ?? surface
  }
  return `${create} Also ${surface[0].toLowerCase()}${surface.slice(1)}`
}

export function ignoredStructuredLaunchInputsWarning(
  intent: AgentLaunchIntent
): { warning: string } | undefined {
  const warning = combineLaunchWarnings(
    intent.agentArgs === undefined
      ? undefined
      : 'Started a structured chat session using saved agent Arguments; the per-launch argument override was ignored.',
    // Credential directories stay host-derived.
    intent.accountEnv ? STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING : undefined
  )
  return warning ? { warning } : undefined
}

/** A terminal's create warning, plus the chat model id it leaves out because it can't take it. */
export function terminalLaunchWarning(
  intent: AgentLaunchIntent,
  create: string | undefined
): { warning: string } | undefined {
  const model = terminalLaunchChatModel(intent)
  const name = TUI_AGENT_DISPLAY_NAMES[intent.agent]
  const warning = combineLaunchWarnings(
    create,
    model === undefined
      ? undefined
      : `Started ${name} in a terminal, which can't run the chat model ${model}, so ${name} uses its own default model.`
  )
  return warning ? { warning } : undefined
}
