import { createLocalWorkerStartDispatch } from './local-worker-start-dispatch'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'
import { resolveWorkerConfiguredAgentParams } from './worker-configured-agent-preflight'
import { waitForWorkerAgentReady } from '../../../../launched-agent-composer-readiness'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal-wait-blocked-reason-legacy-alias'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { DispatchContextRow, RunRow, TaskRow } from '../../../../orchestration/types'
import type {
  OrchestrationCallerIdentity,
  OrchestrationSessionCaller
} from '../../../../orchestration/orchestration-caller-identity'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  resolveWorkerStartModeOnHost,
  type WorkerStartModeReceipt
} from '../../orchestration-worker-start-mode'
import { EXISTING_WORKTREE_SETUP, placeWorkerAgent } from './worker-start-agent-placement'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'
import { assertOrchestrationWorktreeCreationSupported } from './folder-worktree-placement'
import { resolveWorkerWorktreeCreationTarget } from './worker-worktree-creation'
import type { WorkerStartInput } from './worker-start-schema'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './worker-setup-gate'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import { assertExplicitWorkerUsable } from './explicit-worker-terminal-validation'
import { resolveDispatchAssigneeParty } from '../../../../orchestration/orchestration-party'
import { chatAssigneeOf, chatWorkerMode } from '../chat-assignee-admission'
import { recordCreatedWorkerTerminalCustody } from './created-worker-terminal-custody'
import { releaseRetriedWorkerTerminal } from './retried-worker-terminal-release'
import { requireWorkerAuthority, type WorkerEffect } from './worker-topology'
import { prepareLocalWorkerStart } from './worker-start-validation'
import { deliverAndSettleWorkerStartReadiness } from './worker-start-readiness-settlement'
import type { WorkerStartMutation } from './worker-start-mutation'
import { prepareWorkerStartCard } from '../../../../orchestration/worker-start-card'
import { rebindReusedStructuredWorker } from '../../orchestration-structured-worker-session'
import { placedWorkerParty, type WorkerFollowUp } from './worker-follow-up-placement'

export async function startLocalWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  /** Called only once effect-free validation passes, so a refused start binds no new Run. */
  bindRun: () => RunRow
  taskDeps: string[] | undefined
  coordinator: OrchestrationCallerIdentity | null
  callerSession?: OrchestrationSessionCaller
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
  /** Settings-driven; the executing host still gets to refuse below. */
  mode: WorkerStartModeReceipt
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
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const creationTargetFor = (callerWorktreeId: string) =>
    resolveWorkerWorktreeCreationTarget({
      runtime,
      requestedWorktree,
      repo: params.repo,
      callerWorktreeId
    })
  const launchParams = await resolveWorkerConfiguredAgentParams(runtime, params, async () => {
    const callerWorkspaceId = await resolveDispatchCallerWorktreeId(
      runtime,
      params.from,
      callerSession
    )
    return createsWorktree
      ? { repo: (await creationTargetFor(callerWorkspaceId)).repoSelector }
      : {
          worktree: requestedWorktree === 'current' ? `id:${callerWorkspaceId}` : requestedWorktree
        }
  })
  let openCodeModelLaunchSupported = false
  if (!createsWorktree && launchParams.agent === 'opencode' && launchParams.model) {
    const callerWorkspaceId = await resolveDispatchCallerWorktreeId(
      runtime,
      params.from,
      callerSession
    )
    openCodeModelLaunchSupported = await probeWorkerOpenCodeModelLaunchSupport(
      runtime,
      launchParams,
      { worktree: requestedWorktree === 'current' ? `id:${callerWorkspaceId}` : requestedWorktree }
    )
  }

  const { agent, launch } = prepareLocalWorkerStart({
    params: launchParams,
    createsWorktree,
    runtime,
    openCodeModelLaunchSupported
  })

  const coordinatorWorktreeId = await resolveDispatchCallerWorktreeId(
    runtime,
    params.from,
    callerSession
  )
  const creationTarget = createsWorktree
    ? await creationTargetFor(coordinatorWorktreeId)
    : undefined
  if (creationTarget) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: creationTarget.repoSelector,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  let resolvedWorktree: Awaited<ReturnType<typeof placeWorkerAgent>>['worktree'] | undefined =
    creationTarget
      ? undefined
      : requestedWorktree === 'current'
        ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorWorktreeId}`)
        : await runtime.showManagedTerminalWorkspace(requestedWorktree)
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
  const hostMode = resolveWorkerStartModeOnHost(runtime, args.mode, resolvedWorktree?.id, agent)
  let mode = chatWorkerMode(await hostMode, chat)

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
  try {
    placed = await placeWorkerAgent({
      runtime,
      db,
      dispatchId: started.dispatch.id,
      taskId: task.id,
      params,
      requestedWorktree,
      creationTarget,
      resolvedWorktree,
      mode,
      agent,
      launchPreferences: launch.preferences,
      effects,
      onStage,
      followUp: args.followUp
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
    persistWorkerReadinessStage(setupStage)

    failedStage = 'agent_readiness'
    // A structured worker's setup gate and its preamble's wait share one deadline: the timeout.
    const readinessDeadline = Date.now() + (params.timeoutMs ?? 60_000)
    // Structured readiness comes from preamble delivery, not TUI idle; only repo wait-for-setup policy gates here.
    const wait = structuredSession
      ? await awaitStructuredWorkerSetupGate({
          runtime,
          setup: setupReceipt,
          effects,
          timeoutMs: Math.max(0, readinessDeadline - Date.now())
        })
      : workerChat
        ? // A chat takes its task as a queued send whatever it is doing, so nothing is waited on.
          null
        : await waitForWorkerAgentReady(runtime, terminalHandle, {
            agent,
            reusesTerminal: Boolean(params.terminal),
            creation: placed.terminalCreation,
            timeoutMs: params.timeoutMs ?? 60_000
          })
    if (wait) {
      persistWorkerSetupWaitOutcome({ ...setupStage, wait })
      if (!wait.satisfied) {
        if (setupReceipt.state === 'failed') {
          failedStage = 'setup_wait'
        }
        throw new Error(
          wait.blockedReason
            ? `Agent startup blocked: ${describeTerminalWaitBlockedReason(wait.blockedReason)}`
            : structuredSession
              ? `Setup did not finish before the structured worker started (${wait.status}).`
              : `Agent did not become ready (${wait.status}).`
        )
      }
    }
    const terminalAuthority = authority ?? requireWorkerAuthority(runtime, terminalHandle)
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: resolvedWorktree.id,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership: external ? 'external' : 'created'
    })
    if (workerChat) {
      rebindReusedStructuredWorker(runtime, terminalHandle, db)
    }

    result = await deliverAndSettleWorkerStartReadiness({
      runtime,
      db,
      run,
      task: placed.extraSpec ? { ...task, spec: `${task.spec}\n\n${placed.extraSpec}` } : task,
      dispatchId: started.dispatch.id,
      dispatchDepth: started.dispatch.depth,
      structuredSession,
      terminalHandle,
      coordinatorHandle: params.from,
      devMode: params.devMode,
      requestId: orchestrationMutation?.requestId ?? started.dispatch.id,
      agent: agent ?? null,
      launchedAgent: external || workerChat ? null : (agent ?? null),
      setupReceipt,
      launchReceipt: launch.receipt,
      mode,
      timeoutMs: params.timeoutMs ?? 60_000,
      readinessDeadline,
      effects,
      terminalRevealWarning: placed.warning,
      onStage
    })
  } catch (error) {
    result = await failWorkerStartWithReceipt({
      runtime,
      structuredSession: placed?.structuredSession ?? null,
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: placed?.setupReceipt ?? EXISTING_WORKTREE_SETUP,
      launch: launch.receipt,
      mode
    })
  }
  if (
    !params.terminal &&
    terminalHandle &&
    result &&
    typeof result === 'object' &&
    'state' in result &&
    result.state === 'ready'
  ) {
    recordStart({
      dispatchId: started.dispatch.id,
      workerAddress: terminalHandle,
      task: task.spec
    })
  }
  return result
}
