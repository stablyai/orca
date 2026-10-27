import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING } from '../../shared/agent-launch-account-env'

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
