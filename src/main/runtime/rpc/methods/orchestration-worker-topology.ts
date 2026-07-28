import type { TuiAgent } from '../../../../shared/types'
import {
  createOrchestrationOperationCommitTracker,
  isAgentSessionOperationOutcomeUnknown
} from '../../../../shared/orchestration-agent-prompt-outcome'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { createWorkerWorktreeCommitRecorder } from './orchestration-worktree-commit'

export type WorkerEffect = {
  kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'
  action?: string
  role?: string
  id?: string
  state?: string
  tabId?: string
  leafId?: string
  requested?: string
  effective?: string
  source?: string
  hookFound?: boolean
  startupPolicy?: string
  terminalId?: string
}

export type WorkerSetupReceipt = {
  requested: 'run' | 'skip' | 'inherit' | 'not_applicable'
  effective: 'run' | 'skip' | 'inherit' | 'not_applicable'
  source: string
  hookFound: boolean
  startupPolicy: 'start-immediately' | 'wait-for-setup'
  state:
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'not_configured'
    | 'spawn_failed'
    | 'not_applicable'
}

export function initialWorkerSetupReceipt(
  createsWorktree: boolean,
  setup?: 'run' | 'skip' | 'inherit',
  source = workerSetupSource(createsWorktree, Boolean(setup))
): WorkerSetupReceipt {
  return {
    requested: createsWorktree ? (setup ?? 'run') : 'not_applicable',
    effective: createsWorktree ? (setup ?? 'run') : 'not_applicable',
    source,
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: createsWorktree ? 'not_configured' : 'not_applicable'
  }
}

export function workerSetupSource(createsWorktree: boolean, explicitSetup: boolean): string {
  return createsWorktree
    ? explicitSetup
      ? 'explicit_request'
      : 'orchestration_default'
    : 'existing_worktree'
}

export function appendReusedWorkerWorktreeEffects(
  effects: WorkerEffect[],
  worktreeId: string | undefined
): void {
  if (!worktreeId) {
    return
  }
  effects.push(
    { kind: 'worktree', action: 'reused', id: worktreeId },
    { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
  )
}

export function applyWaitForSetupOutcome(
  receipt: WorkerSetupReceipt,
  effects: WorkerEffect[],
  wait: { satisfied: boolean; status: string }
): void {
  if (receipt.startupPolicy !== 'wait-for-setup' || receipt.state !== 'running') {
    return
  }
  if (wait.satisfied) {
    receipt.state = 'succeeded'
  } else if (wait.status === 'exited') {
    receipt.state = 'failed'
  } else {
    return
  }
  const setupEffect = effects.find((effect) => effect.kind === 'setup')
  if (setupEffect) {
    setupEffect.state = receipt.state
  }
}

export async function createWorkerWorktree(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  requestedWorktree: string
  coordinatorWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  params: {
    repo?: string
    name?: string
    baseBranch?: string
    displayName?: string
    comment?: string
    setup?: 'run' | 'skip' | 'inherit'
    from: string
  }
  agent: TuiAgent
  effects: WorkerEffect[]
  signal?: AbortSignal
  terminalIdentity: {
    agentSessionCreateOperationId: string
    tabId: string
    leafId: string
    preAllocatedHandle: string
  }
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
  setupReceipt: WorkerSetupReceipt
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  db.recordWorkerStage({ dispatchId, stage: 'worktree_creating', effects })
  const committedTerminalEffect: WorkerEffect = {
    kind: 'terminal',
    role: 'agent',
    action: 'created_pending_receipt',
    id: args.terminalIdentity.preAllocatedHandle
  }
  const worktreeCommit = createWorkerWorktreeCommitRecorder({
    db,
    dispatchId,
    action: requestedWorktree === 'new-child' ? 'created_child' : 'created_top_level',
    effects
  })
  const startupCommit = createOrchestrationOperationCommitTracker(
    'Startup terminal creation',
    () => {
      effects.push(committedTerminalEffect)
      db.recordWorkerStage({
        dispatchId,
        stage: 'terminal_creation_committed',
        terminalHandle: args.terminalIdentity.preAllocatedHandle,
        effects,
        residualResources: effects.filter((effect) => effect.action?.startsWith('created'))
      })
    }
  )
  let created
  try {
    created = await runtime.createManagedWorktree({
      repoSelector: params.repo ?? coordinatorWorktree.repoId,
      name: params.name as string,
      baseBranch: params.baseBranch,
      displayName: params.displayName,
      comment: params.comment,
      runHooks: setupDecision === 'run',
      setupDecision,
      awaitTerminalProvisioning: true,
      observeSetupCompletion: true,
      createdWithAgent: args.agent,
      startupAgent: args.agent,
      activate: false,
      signal: args.signal,
      onWorktreeCreateCommitted: worktreeCommit.onCommitted,
      lineage: {
        parentWorktree: requestedWorktree === 'new-child' ? coordinatorWorktree.id : undefined,
        noParent: requestedWorktree === 'new-top-level',
        callerTerminalHandle: params.from
      },
      startupTerminalIdentity: {
        ...args.terminalIdentity,
        onPtySpawnCommitted: startupCommit.onCommitted
      }
    })
    const terminalHandle = created.startupTerminal?.handle
    worktreeCommit.onCommitted(created.worktree)
    db.recordWorkerStage({
      dispatchId,
      stage: 'worktree_created',
      worktreeId: created.worktree.id,
      effects,
      residualResources: effects
    })
    const setupReceipt = {
      requested: setupDecision,
      effective: setupDecision,
      source: params.setup ? 'explicit_request' : 'orchestration_default',
      hookFound: created.setupReceipt?.hookFound ?? false,
      startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
      state: created.setupReceipt?.state ?? 'not_configured'
    }
    if (!terminalHandle) {
      throw new Error(created.warning ?? 'Agent-first worktree creation returned no terminal.')
    }
    const committedEffectIndex = effects.indexOf(committedTerminalEffect)
    if (committedEffectIndex >= 0) {
      effects.splice(committedEffectIndex, 1)
    }
    const listed = await runtime.listTerminals(`id:${created.worktree.id}`)
    const setupTerminalHandle = created.setupReceipt?.terminalHandle
    for (const terminal of listed.terminals) {
      effects.push({
        kind: 'terminal',
        role:
          terminal.handle === terminalHandle
            ? 'agent'
            : terminal.handle === setupTerminalHandle
              ? 'setup'
              : 'configured_tab',
        action: terminal.handle === terminalHandle ? 'reused_agent_terminal' : 'created',
        id: terminal.handle,
        tabId: terminal.tabId,
        leafId: terminal.leafId
      })
    }
    const setupTerminal = effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'setup'
    )
    effects.push({
      kind: 'setup',
      action: setupDecision,
      requested: setupReceipt.requested,
      effective: setupReceipt.effective,
      source: setupReceipt.source,
      hookFound: setupReceipt.hookFound,
      startupPolicy: setupReceipt.startupPolicy,
      state: setupReceipt.state,
      terminalId: setupTerminalHandle ?? setupTerminal?.id
    })
    return {
      worktree: created.worktree as Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
      terminalHandle,
      setupReceipt
    }
  } catch (error) {
    if (isAgentSessionOperationOutcomeUnknown(error)) {
      startupCommit.onCommitted()
    }
    startupCommit.rethrowIfCommitted(error)
    worktreeCommit.rethrowIfCommitted(error)
    throw error
  }
}

export function monitorWorkerSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setupReceipt.startupPolicy !== 'start-immediately' ||
    args.setupReceipt.state !== 'running'
  ) {
    return
  }
  // Why: setup is intentionally non-gating, but command completion remains durable evidence.
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const evidence = args.db.updateWorkerSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects: args.effects.map((effect) =>
          effect.kind === 'setup' ? { ...effect, state: setupState } : effect
        )
      })
      if (!evidence.changed) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Setup ${setupState} for worker ${args.dispatchId}`,
        type: 'status',
        priority: setupState === 'failed' ? 'high' : 'normal',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          setupState,
          terminalHandle: setupTerminal.id
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
}
