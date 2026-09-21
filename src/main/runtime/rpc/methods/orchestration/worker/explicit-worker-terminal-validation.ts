import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'

/**
 * Admits a caller-supplied `--terminal` as this dispatch's worker pane.
 *
 * Three refusals, all of which must happen before anything is created: a coordinator adopted as its
 * own worker answers its own dispatch preamble forever, a pane in another worktree is not this
 * dispatch's to take, and a pane with no agent cannot read a preamble at all.
 */
export async function assertExplicitWorkerTerminalUsable(args: {
  runtime: OrcaRuntimeService
  terminal: string
  from: string
  coordinatorPane: string | null
  resolvedWorktreeId: string | undefined
}): Promise<void> {
  const { runtime, terminal, from, coordinatorPane, resolvedWorktreeId } = args
  const explicitTerminal = await runtime.showTerminal(terminal)
  const targetPane = runtime.getTerminalPaneKey(terminal)
  const callerPane = coordinatorPane ?? runtime.getTerminalPaneKey(from)
  // A structured coordinator has no terminal to show, so its own identity is the raw handle plus
  // the pane key; showing `from` unconditionally would throw for exactly those callers.
  const coordinatorHandle = isStructuredWorkerHandle(from)
    ? from
    : (await runtime.showTerminal(from)).handle
  if (
    explicitTerminal.handle === coordinatorHandle ||
    (targetPane !== null && targetPane === callerPane)
  ) {
    throw new OrchestrationError(
      'terminal_is_coordinator',
      `Terminal ${terminal} is this coordinator's own terminal. Pass --terminal for a different agent pane, or omit it so worker-start creates one.`
    )
  }
  if (explicitTerminal.worktreeId !== resolvedWorktreeId) {
    throw new OrchestrationError(
      'terminal_worktree_mismatch',
      `Terminal ${terminal} does not belong to worktree ${resolvedWorktreeId}.`
    )
  }
  if (!(await runtime.isTerminalRunningAgent(terminal))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Terminal ${terminal} is not running a recognized agent.`
    )
  }
}
