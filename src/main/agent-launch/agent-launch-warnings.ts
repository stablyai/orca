import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING } from '../../shared/agent-launch-account-env'

/**
 * Two warnings, both true, neither droppable.
 *
 * Mirrors how the create combines its own failures — `appendFailure` in
 * runtime-local-worktree-terminal-startup.ts — which append rather than replace.
 */
export function combineLaunchWarnings(
  create: string | undefined,
  surface: string | undefined
): string | undefined {
  if (!create || !surface) {
    return create ?? surface
  }
  return `${create} Also ${surface[0].toLowerCase()}${surface.slice(1)}`
}

/**
 * Structured chat uses saved Arguments and its host-derived home, so a per-call override of either
 * still needs a truthful warning.
 */
export function ignoredStructuredLaunchInputsWarning(
  intent: AgentLaunchIntent
): { warning: string } | undefined {
  const warning = combineLaunchWarnings(
    intent.agentArgs === undefined
      ? undefined
      : 'Started a structured chat session using saved agent Arguments; the per-launch argument override was ignored.',
    // Why: a structured home stays host-derived (no client-chosen credential dirs).
    intent.accountEnv ? STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING : undefined
  )
  return warning ? { warning } : undefined
}
