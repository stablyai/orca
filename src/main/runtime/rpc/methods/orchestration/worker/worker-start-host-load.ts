import { collectHostLoad } from '../../../../../memory/host-memory'
import {
  HOST_LOAD_EXCEEDED_CODE,
  HOST_LOAD_EXCEEDED_NEXT_STEPS,
  evaluateHostLoadGate,
  hostLoadExceededMessage,
  type HostLoadSample
} from '../../../../../../shared/host-load-gate'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveWorktreeHostRouting } from '../../../../worktree-launch-host-repo'

/** `ambiguous` is a refusal, not a host: rival repo rows disagree about where the worktree runs. */
export type WorkerStartExecutionHostId = ExecutionHostId | 'ambiguous'

/** Refuses `--max-load` with `--on`: only the execution host reads its own load. */
export function assertMaxLoadNotCombinedWithOn(params: { maxLoad?: number; on?: string }): void {
  if (params.maxLoad === undefined || !params.on) {
    return
  }
  throw new OrchestrationError(
    'invalid_argument',
    '--max-load gates workers on the Run home only; it cannot combine with --on.'
  )
}

/**
 * Refuses a worker-start whose resolved worktree executes off the Run home, else gates the Run
 * home's own per-core load. Runs before any Task, Dispatch row, or worktree creation.
 */
export function assertHostLoadPermitsWorkerStart(
  params: { maxLoad?: number },
  executionHostId: WorkerStartExecutionHostId | undefined,
  sampleHostLoad: () => HostLoadSample = collectHostLoad
): void {
  if (params.maxLoad === undefined) {
    return
  }
  if (executionHostId === 'ambiguous') {
    throw new OrchestrationError(
      'invalid_argument',
      '--max-load cannot be applied: the worktree host could not be resolved unambiguously. Start the worker without --max-load.'
    )
  }
  // Why: this runtime cannot read a connected server's load, so its verdict is only the Run home's.
  if (executionHostId !== undefined && executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    throw new OrchestrationError(
      'invalid_argument',
      `--max-load samples the Run home load only; the resolved worktree runs on ${executionHostId}. Start the worker on that host's own Orca, or omit --max-load.`
    )
  }
  const verdict = evaluateHostLoadGate(sampleHostLoad(), params.maxLoad)
  if (!verdict.exceeded) {
    return
  }
  throw new OrchestrationError(HOST_LOAD_EXCEEDED_CODE, hostLoadExceededMessage(verdict), {
    effectsApplied: false,
    cpuCoreCount: verdict.cpuCoreCount,
    loadAverage1m: verdict.loadAverage1m,
    loadRatio: verdict.loadRatio,
    maxLoad: verdict.maxLoad,
    nextSteps: [...HOST_LOAD_EXCEEDED_NEXT_STEPS]
  })
}

/** Resolves the execution host only when `--max-load` asks for the gate, then applies it. */
export async function assertWorkerStartHostLoadPermits(
  runtime: Pick<OrcaRuntimeService, 'showRepo' | 'listRepos'>,
  params: { maxLoad?: number; repo?: string },
  worktrees: {
    creationWorktree: { repoId: string } | undefined
    resolvedWorktree: { repoId: string; hostId?: ExecutionHostId } | undefined
  }
): Promise<void> {
  if (params.maxLoad === undefined) {
    return
  }
  assertHostLoadPermitsWorkerStart(
    params,
    await resolveWorkerStartExecutionHostId(runtime, {
      ...worktrees,
      repoSelector: params.repo
    })
  )
}

/** The host that will actually run the worker, for the Run-home load gate. */
async function resolveWorkerStartExecutionHostId(
  runtime: Pick<OrcaRuntimeService, 'showRepo' | 'listRepos'>,
  args: {
    creationWorktree: { repoId: string } | undefined
    resolvedWorktree: { repoId: string; hostId?: ExecutionHostId } | undefined
    repoSelector: string | undefined
  }
): Promise<WorkerStartExecutionHostId | undefined> {
  if (args.creationWorktree) {
    const repo = await runtime.showRepo(args.repoSelector ?? args.creationWorktree.repoId)
    return getRepoExecutionHostId(repo)
  }
  const worktree = args.resolvedWorktree
  if (!worktree) {
    return undefined
  }
  // A hostless snapshot can still be remote via a legacy row; rival rows must refuse, not guess local.
  const routing = resolveWorktreeHostRouting(runtime.listRepos(), worktree)
  if (routing.kind === 'ambiguous') {
    return 'ambiguous'
  }
  return routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
}
