import type { LocalWorkerStartArgs } from './local-worker-start-args'
import { createLocalWorkerStartDispatch } from './local-worker-start-dispatch'
import * as system from '../system-worker-coordinator'
import { refuseClaimedWorkerTerminal } from '../../../../../orchestration/db/worker-dispatch/worker-terminal-claim'
import { probeWorkerOpenCodeModelLaunchSupport } from './launch/worker-opencode-model-preflight'
import { resolveWorkerConfiguredAgentParams } from './launch/worker-configured-agent-preflight'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  refuseUnmatchedWorkerSelector,
  workerStartTargetLabel
} from './worker-start-selector-refusal'
import { resolveWorkerStartModeOnHost } from '../../structured-workers/orchestration-worker-start-mode'
import { lineageModeForResolvedAgent } from './worker-chat-lineage'
import { EXISTING_WORKTREE_SETUP, placeWorkerAgent } from './placement/worker-start-agent-placement'
import { resolveExistingWorkerWorkspace } from './placement/folder-worktree-placement'
import { resolveWorkerWorktreeCreationTarget } from './placement/worker-worktree-creation'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage
} from './readiness/worker-setup-gate'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import {
  assertExplicitWorkerUsable,
  explicitWorkerWorkspace
} from './placement/explicit-worker-terminal-validation'
import { resolveDispatchAssigneeParty } from '../../../../../orchestration/addressing/orchestration-party'
import { chatAssigneeOf, chatWorkerMode } from '../../chat-assignee-admission'
import { recordCreatedWorkerTerminalCustody } from './placement/created-worker-terminal-custody'
import {
  closeFailedSetupOnceRetryReady,
  releaseRetriedWorkerTerminal
} from '../release/retried-worker-terminal-release'
import { requireWorkerAuthority, type WorkerEffect } from './placement/worker-placement-topology'
import { prepareLocalWorkerStart } from './launch/worker-start-validation'
import { deliverAndSettleWorkerStartReadiness } from './readiness/worker-start-readiness-settlement'
import { handOverWhenReady } from './readiness/placed-worker-readiness'
import {
  prepareWorkerStartCard,
  recordWorkerStartOutcome
} from '../../../../../orchestration/workers/launch/worker-start-card'
import { rebindReusedStructuredWorker } from '../../structured-workers/orchestration-structured-worker-session'
import { placedWorkerParty } from '../follow-up/worker-follow-up-placement'

export async function startLocalWorker(args: LocalWorkerStartArgs): Promise<unknown> {
  const { runtime, db, coordinator, callerSession, orchestrationMutation } = args
  const callerWorkspace = () =>
    args.systemCoordinator
      ? Promise.resolve(args.systemCoordinator.workspaceId)
      : resolveDispatchCallerWorktreeId(runtime, args.params.from, callerSession)
  const recordStart = prepareWorkerStartCard(runtime, callerSession)
  // `--terminal` names a party: a chat by its `/clear` root address, as its Dispatch does.
  const terminal = args.params.terminal && resolveDispatchAssigneeParty(args.params.terminal, db)
  const params = terminal ? { ...args.params, terminal: terminal.address } : args.params
  const chat = terminal ? chatAssigneeOf(terminal) : null
  const requestedWorktree =
    params.worktree ?? (await explicitWorkerWorkspace(runtime, db, terminal))
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const creationTargetFor = (callerWorktreeId: string) =>
    resolveWorkerWorktreeCreationTarget({
      runtime,
      requestedWorktree,
      repo: params.repo,
      callerWorktreeId,
      crossStoreParent: params.crossStoreParent
    })
  const coordinatorWorktreeId = await refuseUnmatchedWorkerSelector(
    { flag: '--from', value: params.from },
    callerWorkspace
  )
  const existingWorktree =
    requestedWorktree === 'current' ? `id:${coordinatorWorktreeId}` : requestedWorktree
  const targetLabel = workerStartTargetLabel({ ...args.params, createsWorktree, requestedWorktree })
  const launchParams = await refuseUnmatchedWorkerSelector(targetLabel, () =>
    resolveWorkerConfiguredAgentParams(runtime, params, async () =>
      createsWorktree
        ? { repo: (await creationTargetFor(coordinatorWorktreeId)).repoSelector }
        : { worktree: existingWorktree }
    )
  )
  let openCodeModelLaunchSupported = false
  if (!createsWorktree && launchParams.agent === 'opencode' && launchParams.model) {
    openCodeModelLaunchSupported = await refuseUnmatchedWorkerSelector(targetLabel, () =>
      probeWorkerOpenCodeModelLaunchSupport(runtime, launchParams, { worktree: existingWorktree })
    )
  }

  const { agent, launch } = prepareLocalWorkerStart({
    params: launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })
  system.applySystemWorkerLaunch(args.systemCoordinator, launch)

  const creationTarget = createsWorktree
    ? await creationTargetFor(coordinatorWorktreeId)
    : undefined
  let resolvedWorktree: Awaited<ReturnType<typeof placeWorkerAgent>>['worktree'] | undefined =
    await refuseUnmatchedWorkerSelector(targetLabel, () =>
      resolveExistingWorkerWorkspace(runtime, creationTarget, existingWorktree)
    )
  if (terminal) {
    await assertExplicitWorkerUsable({
      runtime,
      db,
      terminal,
      from: params.from,
      coordinator,
      resolvedWorktreeId: resolvedWorktree?.id
    })
  }
  const decided = lineageModeForResolvedAgent(runtime, args.mode, { ...args, params, agent })
  const hostMode = resolveWorkerStartModeOnHost(
    runtime,
    decided,
    resolvedWorktree?.id,
    agent,
    Boolean(chat)
  )
  let mode = chatWorkerMode(await hostMode, chat)
  system.assertSystemWorkerMode(args.systemCoordinator, mode.mode)

  // Synchronous through the Dispatch insert, so nothing else claims the terminal in between.
  refuseClaimedWorkerTerminal(db, params.terminal, runtime, args.followUp?.of)
  const run = args.bindRun()
  const started = createLocalWorkerStartDispatch(args, {
    params,
    run,
    requestedWorktree,
    createsWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktree?.id,
    repoSelector: creationTarget?.repoSelector,
    agent,
    launchReceipt: launch.receipt
  })
  releaseRetriedWorkerTerminal(runtime, db, params)
  const effects: WorkerEffect[] = []
  const task = started.task
  if (resolvedWorktree) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  let terminalHandle = params.terminal
  let placed: Awaited<ReturnType<typeof placeWorkerAgent>> | undefined
  let failedStage = 'terminal_create'
  const onStage = (stage: string) => {
    failedStage = stage
  }
  let result: unknown
  const failStart = (error: unknown, stage = failedStage): Promise<unknown> =>
    failWorkerStartWithReceipt({
      runtime,
      structuredSession: placed?.structuredSession ?? null,
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage: stage,
      error,
      setup: placed?.setupReceipt ?? EXISTING_WORKTREE_SETUP,
      launch: placed?.launch ?? launch.receipt,
      mode
    })
  const recordOutcome = (outcome: unknown): void => {
    closeFailedSetupOnceRetryReady(runtime, db, params.retryOf, outcome)
    recordWorkerStartOutcome(recordStart, outcome, {
      reusedTerminal: Boolean(params.terminal),
      dispatchId: started.dispatch.id,
      taskId: task.id,
      workerAddress: terminalHandle,
      task: task.spec,
      agent: agent ?? null,
      followUp: args.followUp && { of: args.followUp.of, reopened: Boolean(placed?.reopened) }
    })
  }
  try {
    placed = await placeWorkerAgent({
      runtime,
      db,
      dispatchId: started.dispatch.id,
      taskId: task.id,
      params,
      requestedWorktree,
      creationTarget,
      orchestrationRunId: run.id,
      resolvedWorktree,
      mode,
      agent,
      launch,
      effects,
      onStage,
      followUp: args.followUp,
      requiredMode: args.systemCoordinator?.requiredMode
    })
    mode = placed.mode
    resolvedWorktree = placed.worktree
    terminalHandle = placed.terminalHandle
    const { structuredSession, setupReceipt } = placed
    const { workerChat, external, created, authority } = placedWorkerParty(placed, chat, terminal)
    const setupStage = {
      db,
      dispatchId: started.dispatch.id,
      worktreeId: resolvedWorktree.id,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    recordCreatedWorkerTerminalCustody(runtime, setupStage, created && !structuredSession)
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    const launchedAt = Date.now()
    failedStage = 'agent_readiness'
    const timeoutMs = params.timeoutMs ?? 60_000
    const readinessDeadline = Date.now() + timeoutMs
    const readiness = {
      agent,
      reusesTerminal: Boolean(params.terminal),
      creation: placed.terminalCreation
    }
    // Fixed now: the hand-over may run later, from the background wait.
    const placement = placed
    const handle = terminalHandle
    const worktreeId = resolvedWorktree.id
    // A hand-over from the background wait gets a fresh delivery budget; one in time keeps the shared one.
    const bindTerminal = (): void => {
      const terminalAuthority = authority ?? requireWorkerAuthority(runtime, handle)
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle,
        ...terminalAuthority,
        worktreeId,
        effects,
        setupState: setupReceipt.state,
        terminalOwnership: external ? 'external' : 'created'
      })
      system.bindSystemWorkerCoordinator(
        args.systemCoordinator,
        db,
        terminalAuthority.paneKey,
        started.dispatch.id,
        handle
      )
    }
    const handOver = async (deliveryDeadline = readinessDeadline): Promise<unknown> => {
      bindTerminal()
      if (workerChat) {
        rebindReusedStructuredWorker(handle, db)
      }
      return deliverAndSettleWorkerStartReadiness({
        runtime,
        db,
        run,
        task: placement.extraSpec
          ? { ...task, spec: `${task.spec}\n\n${placement.extraSpec}` }
          : task,
        dispatchId: started.dispatch.id,
        dispatchDepth: started.dispatch.depth,
        structuredSession,
        terminalHandle: handle,
        coordinatorHandle: params.from,
        devMode: params.devMode,
        requestId: orchestrationMutation?.requestId ?? started.dispatch.id,
        agent: agent ?? null,
        launchedAgent: external || workerChat ? null : (agent ?? null),
        setupReceipt,
        launchReceipt: placement.launch,
        mode,
        timeoutMs,
        readinessDeadline: deliveryDeadline,
        taskOnly: args.systemCoordinator?.taskOnly,
        decorateTask: args.systemCoordinator?.decorateTask,
        effects,
        terminalRevealWarning: placement.warning,
        onStage
      })
    }
    result = await handOverWhenReady({
      runtime,
      structuredSession,
      workerChat: Boolean(workerChat),
      setupStage,
      readiness,
      timeoutMs,
      readinessDeadline,
      launchedAt,
      receipt: { runId: run.id, taskId: task.id, launch: placed.launch, mode },
      onSetupFailed: () => onStage('setup_wait'),
      handOver,
      bindTerminal,
      onHandedOver: recordOutcome,
      fail: failStart
    })
  } catch (error) {
    result = await failStart(error)
  }
  recordOutcome(result)
  return result
}
