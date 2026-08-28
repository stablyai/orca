import type { RunRow, TaskRow } from '../../orchestration/types'
import type { z } from 'zod'
import type { RpcMethod } from '../core'
import type { WorkerStartParams } from './orchestration-worker-start-schema'
import type { prepareLocalWorkerStart } from './orchestration-worker-start-validation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import {
  initialWorkerEffects,
  reusedWorktreeSetupReceipt
} from './orchestration-worker-start-validation'
import { resolveBoundOutcomeId } from './orchestration-worker-route-admission'
import { deliverWorkerDispatchPrompt } from './orchestration-worker-dispatch-prompt'
import { exposeUtcTimestamp } from '../../orchestration/db/utc-timestamp'
import { persistDispatchProviderSessionBinding } from '../../orchestration/control-plane/provider-session-identity'

/** The EFFECT phase of `orchestration.workerStart`: create the worktree and
 *  terminal, wait for readiness, and settle the Dispatch.
 *
 *  Split from the admit phase purely for size. Everything it needs is passed in,
 *  and the locals it mutates (`terminalHandle`, `failedStage`, `setupReceipt`)
 *  live entirely inside it — nothing after the try block reads them. */
type WorkerStartRuntime = Parameters<RpcMethod['handler']>[1]['runtime']
type ManagedWorkspace = Awaited<ReturnType<WorkerStartRuntime['showManagedTerminalWorkspace']>>

/** Everything the admit phase established that the effects need. Derived from
 *  the producers rather than restated, so a change upstream is a type error
 *  here instead of a silent mismatch. */
export type WorkerStartEffectScope = {
  params: z.infer<typeof WorkerStartParams>
  runtime: WorkerStartRuntime
  db: ReturnType<WorkerStartRuntime['getOrchestrationDb']>
  run: RunRow
  task: TaskRow
  agent: ReturnType<typeof prepareLocalWorkerStart>['agent']
  launch: ReturnType<typeof prepareLocalWorkerStart>['launch']
  creationWorktree: ManagedWorkspace | undefined
  resolvedWorktree: ManagedWorkspace | undefined
  requestedWorktree: string
  readinessTimeoutMs: number
  started: ReturnType<
    ReturnType<WorkerStartRuntime['getOrchestrationDb']>['createStartingWorkerDispatch']
  >
}

export async function runWorkerStartEffects(scope: WorkerStartEffectScope): Promise<unknown> {
  let resolvedWorktree = scope.resolvedWorktree
  const {
    params,
    runtime,
    db,
    run,
    task,
    agent,
    launch,
    creationWorktree,
    requestedWorktree,
    readinessTimeoutMs,
    started
  } = scope
  const effects = initialWorkerEffects(resolvedWorktree?.id ?? null)
  let terminalHandle = params.terminal
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  let setupReceipt: WorkerSetupReceipt = reusedWorktreeSetupReceipt()
  try {
    if (creationWorktree) {
      failedStage = 'worktree_create'
      const created = await createWorkerWorktree({
        runtime,
        db,
        dispatchId: started.dispatch.id,
        requestedWorktree,
        coordinatorWorktree: creationWorktree,
        params,
        agent: agent as TuiAgent,
        launchPreferences: launch.preferences,
        effects
      })
      resolvedWorktree = created.worktree
      terminalHandle = created.terminalHandle
      setupReceipt = created.setupReceipt
    } else if (!terminalHandle) {
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'terminal_creating',
        worktreeId: resolvedWorktree!.id,
        effects
      })
      const terminal = await createExistingWorktreeWorkerTerminal({
        runtime,
        worktreeId: resolvedWorktree!.id,
        agent: agent as TuiAgent,
        launchPreferences: launch.preferences,
        taskId: task.id,
        effects
      })
      terminalHandle = terminal.handle
      terminalRevealWarning = terminal.warning
    } else {
      effects.push({
        kind: 'terminal',
        role: 'agent',
        action: 'reused',
        id: terminalHandle
      })
    }
    if (!resolvedWorktree || !terminalHandle) {
      throw new Error('Worker topology did not resolve an agent terminal and worktree.')
    }
    const setupStage = {
      db,
      dispatchId: started.dispatch.id,
      worktreeId: resolvedWorktree.id,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    failedStage = 'agent_readiness'
    const wait = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: readinessTimeoutMs
    })
    persistWorkerSetupWaitOutcome({ ...setupStage, wait })
    if (!wait.satisfied) {
      if (setupReceipt.state === 'failed') {
        failedStage = 'setup_wait'
      }
      throw new Error(
        wait.blockedReason
          ? `Agent startup blocked: ${wait.blockedReason}`
          : `Agent did not become ready (${wait.status}).`
      )
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    if (resolveBoundOutcomeId(db, run.id)) {
      // The pane/PTY can outlive a provider and host a replacement. Freeze
      // the provider session before any task input lands, so that later
      // process cannot inherit this Dispatch's liveness or mutation rights.
      const dispatchStartedAt = Date.parse(exposeUtcTimestamp(started.worker.created_at) ?? '')
      const providerSession = runtime.getExactWorkerProviderSession(
        terminalHandle,
        params.terminal || !Number.isFinite(dispatchStartedAt) ? 0 : dispatchStartedAt
      )
      if (
        !providerSession ||
        providerSession.processIncarnation !== terminalAuthority.processIncarnation ||
        (agent && providerSession.agent !== agent) ||
        !persistDispatchProviderSessionBinding(db, {
          dispatchId: started.dispatch.id,
          binding: {
            agent: providerSession.agent,
            key: providerSession.providerSession.key,
            id: providerSession.providerSession.id,
            processIncarnation: providerSession.processIncarnation,
            observedAtMs: providerSession.observedAt
          }
        })
      ) {
        throw new OrchestrationError(
          'provider_session_unobservable',
          `Outcome-admitted Dispatch ${started.dispatch.id} cannot accept input until the runtime observes the exact provider session occupying ${terminalHandle}.`
        )
      }
    }
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: resolvedWorktree.id,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership: params.terminal ? 'external' : 'created'
    })

    failedStage = 'dispatch_input'
    await deliverWorkerDispatchPrompt({
      runtime,
      db,
      runId: run.id,
      task,
      params,
      dispatchId: started.dispatch.id,
      depth: started.dispatch.depth,
      terminalHandle,
      capability
    })
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'accepted'
    })
    const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
    monitorWorkerSetup({
      runtime,
      db,
      runId: run.id,
      dispatchId: started.dispatch.id,
      setupReceipt,
      effects
    })
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      setup: setupReceipt,
      launch: launch.receipt,
      timeoutMs: readinessTimeoutMs,
      effects,
      residualResources: [],
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
  } catch (error) {
    return failWorkerStartWithReceipt({
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launch.receipt
    })
  }
}
