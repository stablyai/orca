import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'

/** Validate that an explicitly reused terminal belongs to and is active in the selected worktree. */
export async function validateExplicitWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  worktreeId?: string
}) {
  const terminal = await args.runtime.showTerminal(args.terminalHandle)
  if (terminal.worktreeId !== args.worktreeId) {
    throw new OrchestrationError(
      'terminal_worktree_mismatch',
      `Terminal ${args.terminalHandle} does not belong to worktree ${args.worktreeId}.`
    )
  }
  if (!(await args.runtime.isTerminalRunningAgent(args.terminalHandle))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Terminal ${args.terminalHandle} is not running a recognized agent.`
    )
  }
  return terminal
}

/** Persist the normalized placement and setup request that makes a start attempt replayable. */
export function buildWorkerStartOptions(args: {
  requestedWorktree: string
  resolvedWorktreeId?: string
  creationRepoId?: string
  name?: string
  repo?: string
  baseBranch?: string
  terminal?: string
  agent?: string
  launch: OrchestrationWorkerLaunchReceipt
  timeoutMs: number
  setup?: 'run' | 'skip' | 'inherit'
  createsWorktree: boolean
}) {
  return {
    worktree: args.requestedWorktree,
    resolvedWorktreeId: args.resolvedWorktreeId ?? null,
    name: args.name ?? null,
    repo: args.repo ?? args.creationRepoId ?? null,
    baseBranch: args.baseBranch ?? null,
    terminal: args.terminal ?? null,
    agent: args.agent ?? null,
    launch: args.launch,
    timeoutMs: args.timeoutMs,
    setup: args.createsWorktree ? (args.setup ?? 'run') : 'not_applicable',
    setupSource: args.createsWorktree
      ? args.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
}
