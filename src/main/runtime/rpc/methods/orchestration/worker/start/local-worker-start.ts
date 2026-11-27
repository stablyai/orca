import { createLocalWorkerStartDispatch } from './local-worker-start-dispatch'
import { resolveLocalWorkerStartLaunch } from './launch/worker-opencode-model-preflight'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type {
  DispatchContextRow,
  RunRow,
  TaskRow
} from '../../../../../orchestration/db/orchestration-records'
import type { OrchestrationEntryCaller } from '../../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  refuseUnmatchedWorkerSelector,
  workerStartTargetLabel
} from './worker-start-selector-refusal'
import { preflightWorkerAgentOnHost } from './launch/worker-agent-host-preflight'
import { lineageModeForResolvedAgent } from './worker-chat-lineage'
import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { EXISTING_WORKTREE_SETUP, placeWorkerAgent } from './placement/worker-start-agent-placement'
import { resolveExistingWorkerWorkspace } from './placement/folder-worktree-placement'
import { resolveWorkerWorktreeCreationTarget } from './placement/worker-worktree-creation'
import type { WorkerStartInput } from './worker-start-input'
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
import { requireWorkerAuthority } from './placement/worker-placement-topology'
import { joinWorkerStartWarnings } from './launch/worker-launch-preferences'
import { deliverAndSettleWorkerStartReadiness } from './readiness/worker-start-readiness-settlement'
import { handOverWhenReady, wakeReusedSleptAgent } from './readiness/placed-worker-readiness'
import type { WorkerStartMutation } from './worker-start-mutation'
import {
  prepareWorkerStartCard,
  recordWorkerStartOutcome
} from '../../../../../orchestration/workers/launch/worker-start-card'
import { rebindReusedStructuredWorker } from '../../structured-workers/orchestration-structured-worker-session'
import { placedWorkerParty, type WorkerFollowUp } from '../follow-up/worker-follow-up-placement'

export async function startLocalWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  /** Called only once effect-free validation passes, so a refused start binds no new Run. */
  bindRun: () => RunRow
  taskDeps: string[] | undefined
  coordinator: OrchestrationCallerIdentity | null
  callerSession?: OrchestrationEntryCaller
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
  /** Settings-driven; the executing host still gets to refuse below. */
  mode: WorkerStartModeReceipt
  /** Stamped on the Dispatch so the workers this one starts start as chats too. */
  chatLineage?: boolean
  /** Set when a worker starts its own helper; the helper reports to this Dispatch. */
  helperCreator?: DispatchContextRow
  followUp?: WorkerFollowUp
}): Promise<unknown> {
  const { runtime, db, coordinator, callerSession, orchestrationMutation } = args
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
    () => resolveDispatchCallerWorktreeId(runtime, params.from, callerSession)
  )
  const existingWorktree =
    requestedWorktree === 'current' ? `id:${coordinatorWorktreeId}` : requestedWorktree
  const targetLabel = workerStartTargetLabel({ ...args.params, createsWorktree, requestedWorktree })
  const {
    agent,
    launch,
    warning: retryLaunchWarning
  } = await resolveLocalWorkerStartLaunch({
    params,
    createsWorktree,
    existingWorktree,
    targetLabel,
    runtime,
    resolveTarget: async () =>
      createsWorktree
        ? { repo: (await creationTargetFor(coordinatorWorktreeId)).repoSelector }
        : { worktree: existingWorktree }
  })

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
  const host = { runtime, agent, resolvedWorktree, creationTarget, terminal: params.terminal }
  let mode = chatWorkerMode(await preflightWorkerAgentOnHost({ ...host, mode: decided }), chat)

  const followUp = args.followUp
  if (followUp?.retainedChat) {
    await runtime.ensureStructuredAgentSessionHost()
  }
  const { run, started, retained, effects } = createLocalWorkerStartDispatch(args, {
    params,
    requestedWorktree,
    createsWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktree?.id,
    repoSelector: creationTarget?.repoSelector,
    agent,
    launchReceipt: launch.receipt
  })
  releaseRetriedWorkerTerminal(runtime, db, params)
  const task = started.task
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
      mode,
      warning: joinWorkerStartWarnings(retryLaunchWarning, placed?.warning)
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
      followUp:
        retained && followUp && !terminal ? { ...followUp, reopen: retained.publish } : followUp
    })
    // New worktrees resolve host support after creation, so the final mode receipt may differ from preflight.
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
    if (!retained) {
      persistWorkerReadinessStage(setupStage)
    }

    const launchedAt = Date.now()
    failedStage = 'agent_readiness'
    // A structured worker's setup gate and its preamble's wait share one deadline: the timeout.
    const timeoutMs = params.timeoutMs ?? 60_000
    const readinessDeadline = Date.now() + timeoutMs
    const readiness = {
      agent,
      reusesTerminal: Boolean(params.terminal),
      creation: placed.terminalCreation
    }
    const sleptIncarnation = await wakeReusedSleptAgent(runtime, placed, workerChat, timeoutMs)
    // Fixed now: the hand-over may run later, from the background wait.
    const placement = placed
    const handle = terminalHandle
    const warning = joinWorkerStartWarnings(retryLaunchWarning, placement.warning)
    const awaitingReceipt = { runId: run.id, taskId: task.id, launch: placed.launch, mode, warning }
    // A hand-over from the background wait gets a fresh delivery budget; one in time keeps the shared one.
    const bindTerminal = (): void => {
      if (retained) {
        return retained.assertStarting(started.dispatch.id)
      }
      const terminalAuthority = authority ?? requireWorkerAuthority(runtime, handle)
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle,
        ...terminalAuthority,
        worktreeId: placement.worktree.id,
        effects,
        setupState: setupReceipt.state,
        terminalOwnership: external ? 'external' : 'created',
        sleptProcessIncarnation: sleptIncarnation
      })
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
        effects,
        terminalRevealWarning: warning,
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
      receipt: awaitingReceipt,
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
