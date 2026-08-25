import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  resolvePiRpcWorkerTransportLaunch,
  type PiRpcWorkerTransportLaunch,
  type PiRpcWorkerTransportRequest
} from './orchestration-pi-rpc-worker'

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
  surface?: 'visible' | 'background'
  warning?: string
  transport?: 'pi-rpc'
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

export function requireWorkerAuthority(runtime: OrcaRuntimeService, terminalHandle: string) {
  const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
  const paneKey = authority?.paneKey ?? runtime.getTerminalPaneKey(terminalHandle)
  const processIncarnation =
    authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(terminalHandle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  return {
    paneKey,
    processIncarnation,
    ...(authority?.launchTokenHash ? { launchTokenHash: authority.launchTokenHash } : {}),
    ...(authority?.hostScope ? { hostScope: JSON.stringify(authority.hostScope) } : {})
  }
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
  launchPreferences?: AgentLaunchPreferences
  piRpc?: PiRpcWorkerTransportRequest
  effects: WorkerEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
  setupReceipt: WorkerSetupReceipt
  piRpcLaunch?: PiRpcWorkerTransportLaunch
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  const repoSelector = params.repo ?? coordinatorWorktree.repoId
  const piRpcLaunch = args.piRpc
    ? resolvePiRpcWorkerTransportLaunch({
        runtime,
        workspace: await runtime.showRepo(repoSelector),
        request: args.piRpc
      })
    : undefined
  db.recordWorkerStage({ dispatchId, stage: 'worktree_creating', effects })
  const created = await runtime.createManagedWorktree({
    repoSelector,
    name: params.name as string,
    baseBranch: params.baseBranch,
    displayName: params.displayName,
    comment: params.comment,
    // setupDecision runs setup without the legacy runHooks activation side effect.
    runHooks: false,
    setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    createdWithAgent: args.agent,
    startupAgent: args.agent,
    ...(piRpcLaunch
      ? {
          startup: {
            command: piRpcLaunch.command,
            env: piRpcLaunch.cliInvocation.env
          }
        }
      : args.launchPreferences
        ? { startupLaunchPreferences: args.launchPreferences }
        : {}),
    activate: false,
    lineage: {
      parentWorktree: requestedWorktree === 'new-child' ? coordinatorWorktree.id : undefined,
      noParent: requestedWorktree === 'new-top-level',
      callerTerminalHandle: params.from
    }
  })
  const terminalHandle = created.startupTerminal?.handle
  effects.push({
    kind: 'worktree',
    action: requestedWorktree === 'new-child' ? 'created_child' : 'created_top_level',
    id: created.worktree.id
  })
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
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
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
      leafId: terminal.leafId,
      ...(piRpcLaunch && terminal.handle === terminalHandle ? { transport: 'pi-rpc' as const } : {})
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
    setupReceipt,
    ...(piRpcLaunch ? { piRpcLaunch } : {})
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

export function isUnknownWorkerStartOutcome(error: unknown, stage: string): boolean {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (code === 'operation_unknown') {
    return true
  }
  if (stage !== 'worktree_create') {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection|disconnect|timed?\s*out|runtime changed|outcome unknown/i.test(message)
}
