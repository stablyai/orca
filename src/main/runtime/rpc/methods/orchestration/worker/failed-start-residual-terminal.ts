import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { FailedStartTerminalAdoption } from '../../../../orchestration/db/worker-terminal/failed-start-terminal-adoption'
import type { WorkerEffect } from './worker-topology'

/** True only for an agent terminal this worker-start brought into existence. An explicit
 *  `--terminal` reuse records `reused` and is never residual — it is the caller's terminal. */
function orchestrationCreatedAgentTerminal(
  effects: readonly WorkerEffect[],
  handle: string
): boolean {
  return effects.some(
    (effect) =>
      effect.kind === 'terminal' &&
      effect.role === 'agent' &&
      effect.id === handle &&
      (effect.action?.startsWith('created') === true || effect.action === 'reused_agent_terminal')
  )
}

/**
 * Identity for the terminal a failed start leaves behind, so the failed Dispatch can own it and
 * `worker-release` can close it. Returns nothing unless the pane and process are both provable:
 * an unprovable identity must never authorize a later close.
 */
export function resolveResidualAgentTerminal(args: {
  runtime: OrcaRuntimeService
  effects: readonly WorkerEffect[]
  terminalHandle: string | undefined
  worktreeId: string | null
}): FailedStartTerminalAdoption | undefined {
  const handle = args.terminalHandle
  if (!handle || !orchestrationCreatedAgentTerminal(args.effects, handle)) {
    return undefined
  }
  try {
    const authority = args.runtime.getOrchestrationDispatchAuthority(handle)
    const paneKey = authority?.paneKey ?? args.runtime.getTerminalPaneKey(handle)
    const processIncarnation =
      authority?.processIncarnation ?? args.runtime.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation) {
      return undefined
    }
    return {
      terminalHandle: handle,
      worktreeId: args.worktreeId,
      paneKey,
      processIncarnation,
      hostScope: authority?.hostScope ? JSON.stringify(authority.hostScope) : null
    }
  } catch {
    return undefined
  }
}
