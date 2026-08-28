import { runWorkerStartEffects } from './orchestration-worker-start-effects'
import type { z } from 'zod'
import { createDispatchUnderCertificationIntent } from './orchestration-certification-launch'
import { recordSafeLaunchAdmission } from '../../orchestration/control-plane/route-runtime-events'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  buildWorkerStartOptions,
  prepareLocalWorkerStart
} from './orchestration-worker-start-validation'
import { assertWorkerStartAdmitted } from './orchestration-worker-route-admission'
import { resolveBoundOutcomeId } from './orchestration-worker-route-admission'
import { gitExecFileSync } from '../../../git/runner'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { requireCallerOwnedRunTask } from './orchestration-run-scope'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'

/** The body of `orchestration.workerStart`.
 *
 *  Extracted from the method registration purely so the file stays readable;
 *  the registration in `orchestration-workers.ts` is the only caller and the
 *  behaviour is unchanged. */
export async function handleWorkerStart(
  params: z.infer<typeof WorkerStartParams>,
  ctx: Parameters<RpcMethod['handler']>[1]
): Promise<unknown> {
  const { runtime, orchestrationMutation, orchestrationCompatibilityEvidence } = ctx
  if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      `--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.`
    )
  }
  const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
  const db = runtime.getOrchestrationDb()
  // Why: worker-start was the only Run-scoped verb that skipped this, so a
  // declared --from could name someone else's pane and inherit their depth.
  const { run, task } = requireCallerOwnedRunTask(runtime, db, {
    from: params.from,
    run: params.run,
    task: params.task,
    callerEvidence: orchestrationCompatibilityEvidence,
    verb: 'worker-start'
  })

  if (params.on) {
    return startFederatedWorker({
      params,
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation
    })
  }

  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })

  const coordinatorTerminal = await runtime.showTerminal(params.from)
  const creationWorktree = createsWorktree
    ? await runtime.showManagedWorktree(`id:${coordinatorTerminal.worktreeId}`)
    : undefined
  if (creationWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? creationWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  let resolvedWorktree = creationWorktree
    ? undefined
    : requestedWorktree === 'current'
      ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorTerminal.worktreeId}`)
      : await runtime.showManagedTerminalWorkspace(requestedWorktree)
  // Why before any effect: an uncertified route or a worktree under a live
  // validation lease must fail admission, not fail halfway through creation.
  const admitted = assertWorkerStartAdmitted({
    handle: db,
    runtimeBuildIdentity: runtime.getBuildIdentity(),
    runId: run.id,
    taskId: task.id,
    agent,
    model: params.model,
    effort: params.effort,
    worktreeId: resolvedWorktree?.id,
    terminalHandle: params.terminal,
    certificationIntent: params.certificationIntent,
    retryOf: params.retryOf,
    // A different existing worktree is not proof of exclusive ownership:
    // another terminal may already be writing there. Only a worktree this
    // exact start asks Orca to create is isolated before any launch effect.
    isolatedWorktree: createsWorktree
  })
  let explicitTerminal
  if (params.terminal) {
    explicitTerminal = await runtime.showTerminal(params.terminal)
    if (explicitTerminal.worktreeId !== resolvedWorktree?.id) {
      throw new OrchestrationError(
        'terminal_worktree_mismatch',
        `Terminal ${params.terminal} does not belong to worktree ${resolvedWorktree?.id}.`
      )
    }
    if (!(await runtime.isTerminalRunningAgent(params.terminal))) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Terminal ${params.terminal} is not running a recognized agent.`
      )
    }
  }

  let baseSha: string | null = null
  if (resolvedWorktree?.path) {
    try {
      const observed = gitExecFileSync(['rev-parse', 'HEAD'], {
        cwd: resolvedWorktree.path
      }).trim()
      baseSha = /^[0-9a-f]{40}$/.test(observed) ? observed : null
    } catch {
      baseSha = null
    }
  }
  if (resolveBoundOutcomeId(db, run.id) && !baseSha) {
    throw new OrchestrationError(
      'dispatch_base_unobservable',
      `Outcome-admitted work requires a runtime-observed starting Git SHA for ${resolvedWorktree?.id ?? '<unresolved>'}.`
    )
  }

  const startOptions = buildWorkerStartOptions({
    params,
    createsWorktree,
    agent,
    launchReceipt: launch.receipt,
    resolvedWorktreeId: resolvedWorktree?.id ?? null,
    creationRepoId: creationWorktree?.repoId ?? null,
    baseSha,
    // From upstream #16300: the readiness timeout is derived, not the raw
    // param, so worker-start cannot stall past its transport grace.
    readinessTimeoutMs
  })
  const started = createDispatchUnderCertificationIntent({
    handle: db,
    // Only when the bootstrap was actually exercised: an intent supplied for
    // a route that turned out to be certified already was never used, and
    // consuming it would mark ordinary delivered work as a bootstrap
    // Dispatch, which can never advance.
    intentId: admitted.bootstrapUsed ? params.certificationIntent : undefined,
    claimId: `claim:${orchestrationMutation?.requestId ?? runtime.getRuntimeId()}:${task.id}`,
    create: () =>
      db.createStartingWorkerDispatch({
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth(),
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
  })
  // The admission decision above is a real runtime fact that was previously
  // made and discarded. Certification needs it, so it is written down.
  recordSafeLaunchAdmission(db, {
    dispatchId: started.dispatch.id,
    decision: 'admitted',
    observedAt: new Date().toISOString()
  })
  return runWorkerStartEffects({
    params,
    runtime,
    db,
    run,
    task,
    agent,
    launch,
    creationWorktree,
    resolvedWorktree,
    requestedWorktree,
    readinessTimeoutMs,
    started
  })
}
