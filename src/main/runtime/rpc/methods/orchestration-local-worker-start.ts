/**
 * The local half of `orchestration.workerStart`: resolve the worktree, bring the worker into
 * existence, prove its authority, and hand it the dispatch preamble.
 *
 * Split out of the method file so the federated branch and the transport guards stay readable, and
 * so the structured worker path has somewhere to live that is not a third arm of one handler.
 */

import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { RpcContext } from '../core'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createStructuredWorkerSessionForWorktree,
  createWorkerWorktree,
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession,
  sendStructuredWorkerPreamble
} from './orchestration-structured-worker-session'
import {
  resolveWorkerStartModeOnHost,
  type WorkerStartModeReceipt
} from './orchestration-worker-start-mode'

export async function startLocalWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: { id: string }
  task: { id: string; spec: string }
  readinessTimeoutMs: number
  orchestrationMutation: RpcContext['orchestrationMutation']
  /** Settings-driven; the executing host still gets to refuse below. */
  mode: WorkerStartModeReceipt
}) {
  const { params, runtime, db, run, task, readinessTimeoutMs, orchestrationMutation } = args
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

  const mode = await resolveWorkerStartModeOnHost(runtime, args.mode, resolvedWorktree?.id, agent)

  const startOptions = {
    worktree: requestedWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktree?.id ?? null,
    name: params.name ?? null,
    repo: params.repo ?? creationWorktree?.repoId ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    launch: launch.receipt,
    timeoutMs: readinessTimeoutMs,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: task.id,
    retryOf: params.retryOf,
    startOptions,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation
  })
  const effects: WorkerEffect[] = []
  if (resolvedWorktree) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  let terminalHandle = params.terminal
  let structuredSession: Awaited<
    ReturnType<typeof createStructuredWorkerSessionForWorktree>
  > | null = null
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  let setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }
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
    } else if (!terminalHandle && mode.mode === 'structured') {
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'terminal_creating',
        worktreeId: resolvedWorktree!.id,
        effects
      })
      structuredSession = await createStructuredWorkerSessionForWorktree({
        runtime,
        worktreeId: resolvedWorktree!.id,
        agent: agent as TuiAgent,
        dispatchId: started.dispatch.id,
        effects
      })
      terminalHandle = structuredSession.identity.handle
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
    // A structured session is ready the moment its attach returns ok: there is no boot-to-idle
    // gap and no terminal title to read an idle edge from.
    if (!structuredSession) {
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
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
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
    const preamble = buildDispatchPreamble({
      // Never for a structured worker: dispatching requires `showTerminal(--from)`, which cannot
      // resolve a `structworker_` handle, so advertising the verb would only burn a turn.
      canDispatchSubWorkers:
        !structuredSession && started.dispatch.depth < runtime.getNestedWorkerMaxDepth(),
      taskId: task.id,
      dispatchId: started.dispatch.id,
      taskSpec: task.spec,
      coordinatorHandle: params.from,
      workerHandle: terminalHandle,
      dispatchCapability: capability,
      devMode: params.devMode,
      cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
    })
    await (structuredSession
      ? sendStructuredWorkerPreamble({
          host: structuredSession.host,
          sessionId: structuredSession.identity.sessionId,
          dispatchId: started.dispatch.id,
          preamble
        })
      : runtime.sendTerminalAgentPrompt(terminalHandle, preamble))
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
      mode,
      timeoutMs: readinessTimeoutMs,
      effects,
      residualResources: [],
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
  } catch (error) {
    // A start that never reached ready leaves no settlement to release the hold later, and its
    // session was already published as a chat tab — without the discard the failed start strands a
    // dead "Claude Chat"/"Codex Chat" tab that the durable restore index republishes on every app
    // launch. Both halves are best-effort by construction so neither can replace the real error.
    releaseStructuredWorkerSession(started.dispatch.id, runtime)
    if (structuredSession) {
      await discardStructuredWorkerSession(structuredSession.identity.sessionId, runtime)
    }
    return failWorkerStartWithReceipt({
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launch.receipt,
      mode
    })
  }
}
