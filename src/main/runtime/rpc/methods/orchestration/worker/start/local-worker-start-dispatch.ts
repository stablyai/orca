import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import {
  reusedWorkerLaunchReceipt,
  type OrchestrationWorkerLaunchReceipt
} from './launch/worker-launch-preferences'
import { resolveDispatchAssigneeParty } from '../../../../../orchestration/addressing/orchestration-party'
import type { WorkerStartInput } from './worker-start-input'
import type { startLocalWorker } from './local-worker-start'
import { resolveDispatchCreator } from '../../runs/dispatch-creator'
import { refuseClaimedWorkerTerminal } from '../../../../../orchestration/db/worker-dispatch/worker-terminal-claim'
import { qualifyLiveWorkerFollowUp } from './admission/worker-start-authority'
import { prepareRetainedWorkerChat } from '../follow-up/worker-follow-up-placement'
import { assertWorkerFollowUpUnclaimed } from '../../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { WorkerEffect } from './placement/worker-placement-topology'

export function createLocalWorkerStartDispatch(
  {
    runtime,
    db,
    bindRun,
    taskDeps,
    coordinator,
    callerSession,
    existingTask,
    orchestrationMutation,
    helperCreator,
    followUp,
    chatLineage
  }: Parameters<typeof startLocalWorker>[0],
  {
    params,
    requestedWorktree,
    createsWorktree,
    mode,
    resolvedWorktreeId,
    repoSelector,
    agent,
    launchReceipt
  }: {
    params: WorkerStartInput
    requestedWorktree: string
    createsWorktree: boolean
    mode: WorkerStartModeReceipt
    resolvedWorktreeId: string | undefined
    repoSelector: string | undefined
    agent: TuiAgent | undefined
    launchReceipt: OrchestrationWorkerLaunchReceipt
  }
) {
  const retainedRun = followUp?.retainedChat ? bindRun() : undefined
  if (retainedRun && followUp) {
    qualifyLiveWorkerFollowUp(
      runtime,
      coordinator,
      params.from,
      callerSession,
      retainedRun.id,
      followUp
    )
    assertWorkerFollowUpUnclaimed(db, followUp.of)
  }
  // No await from the native tab and claim checks through the Dispatch insert.
  const retained = followUp?.retainedChat
    ? prepareRetainedWorkerChat(
        runtime,
        db,
        followUp.retainedChat,
        resolvedWorktreeId,
        Boolean(params.terminal)
      )
    : undefined
  refuseClaimedWorkerTerminal(
    db,
    retained?.authority.handle ?? params.terminal,
    runtime,
    followUp?.of,
    retained?.authority.paneKey
  )
  const run = retainedRun ?? bindRun()
  const effects: WorkerEffect[] = resolvedWorktreeId
    ? [
        { kind: 'worktree', action: 'reused', id: resolvedWorktreeId },
        { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
      ]
    : []
  const startOptions = {
    worktree: requestedWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktreeId ?? null,
    name: params.name ?? null,
    repo: repoSelector ?? params.repo ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    // Mail from a reuse start that never binds still names the agent already running there.
    launch: params.terminal
      ? reusedWorkerLaunchReceipt(
          runtime,
          launchReceipt,
          resolveDispatchAssigneeParty(params.terminal, db)
        )
      : launchReceipt,
    timeoutMs: params.timeoutMs ?? 60_000,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from, callerSession),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    requiredCreatorDispatchId: helperCreator?.id,
    taskId: existingTask?.id,
    taskSpec: params.spec,
    adoptTaskId: params.adoptTaskId,
    taskTitle: params.taskTitle,
    taskDeps,
    // A helper's Task sits under its creator's Task, so the Run's Task tree shows who started it.
    taskParentId: params.parent ?? helperCreator?.task_id,
    taskRunId: run.id,
    // A handle-less session creates root Tasks: Task lineage is recorded by terminal only.
    taskCreatedByTerminalHandle: coordinator?.terminalHandle ?? undefined,
    taskCreatedByPaneKey: coordinator?.paneKey ?? undefined,
    taskCreatedByProcessIncarnation: coordinator?.terminalHandle
      ? (runtime.getTerminalProcessIncarnation(coordinator.terminalHandle) ?? undefined)
      : undefined,
    taskCreatedByRunGeneration: run.consumer_generation,
    retryOf: params.retryOf,
    startOptions,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation,
    followUpOf: followUp?.of,
    retainedChat: retained
      ? {
          authority: retained.authority,
          worktreeId: retained.worktreeId,
          effects: [
            ...effects,
            { kind: 'terminal', role: 'agent', action: 'reused', id: retained.authority.handle }
          ]
        }
      : undefined,
    acceptedBy: followUp?.acceptedBy,
    takesMailOf: followUp?.takesMailOf,
    ...(params.origin ? { originRef: params.origin } : {}),
    ...(params.forQuestion ? { forMessageId: params.forQuestion } : {}),
    ...(chatLineage ? { chatLineage } : {})
  })
  return { run, started, retained, effects }
}
