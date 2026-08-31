import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

export async function resolveLocalWorkerPlacement(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  requestedWorktree: string
  createsWorktree: boolean
}) {
  const coordinatorTerminal = await args.runtime.showTerminal(args.params.from)
  const creationWorktree = args.createsWorktree
    ? await args.runtime.showManagedWorktree(`id:${coordinatorTerminal.worktreeId}`)
    : undefined
  if (creationWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime: args.runtime,
      repoSelector: args.params.repo ?? creationWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  const resolvedWorktree = creationWorktree
    ? undefined
    : args.requestedWorktree === 'current'
      ? await args.runtime.showManagedTerminalWorkspace(`id:${coordinatorTerminal.worktreeId}`)
      : await args.runtime.showManagedTerminalWorkspace(args.requestedWorktree)
  if (args.params.terminal) {
    const explicitTerminal = await args.runtime.showTerminal(args.params.terminal)
    if (explicitTerminal.worktreeId !== resolvedWorktree?.id) {
      throw new OrchestrationError(
        'terminal_worktree_mismatch',
        `Terminal ${args.params.terminal} does not belong to worktree ${resolvedWorktree?.id}.`
      )
    }
    if (!(await args.runtime.isTerminalRunningAgent(args.params.terminal))) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Terminal ${args.params.terminal} is not running a recognized agent.`
      )
    }
  }
  return { creationWorktree, resolvedWorktree }
}
