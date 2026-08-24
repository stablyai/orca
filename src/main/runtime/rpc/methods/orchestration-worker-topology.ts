import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'

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

export function residualWorkerEffects(effects: WorkerEffect[]): WorkerEffect[] {
  return effects.filter(
    (effect) => effect.action?.startsWith('created') || effect.action === 'reused_agent_terminal'
  )
}

async function launchInteractiveAgent(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  agent: TuiAgent,
  command: string
): Promise<void> {
  const shellReady = await runtime.waitForTerminal(terminalHandle, {
    condition: 'tui-idle',
    timeoutMs: 30_000
  })
  if (!shellReady.satisfied) {
    throw new Error('interactive_agent_shell_not_ready')
  }
  await runtime.sendTerminal(terminalHandle, { text: command, enter: true })
  if (!(await runtime.waitForTerminalAgentProcess(terminalHandle, agent, 30_000))) {
    throw new Error('interactive_agent_start_failed')
  }
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

export async function createExistingWorktreeWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  taskId: string
  promptDelivery: 'agent-input' | 'startup-command'
  interactiveAgentCommand?: string
  effects: WorkerEffect[]
}): Promise<{
  handle: string
  warning?: string
  promptDelivery: 'agent-input' | 'startup-command'
}> {
  const startupCommandPrompt = args.promptDelivery === 'startup-command'
  const terminal =
    startupCommandPrompt || args.interactiveAgentCommand
      ? await args.runtime.createDeferredAgentTerminal(`id:${args.worktreeId}`, {
          agent: args.agent,
          ...(args.interactiveAgentCommand ? { bareShell: true } : {}),
          ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
          title: `worker-${args.taskId}`,
          surfaceOwner: false
        })
      : await args.runtime.createTerminal(`id:${args.worktreeId}`, {
          // Why: the agent id is not a shell command — `cursor` resolves to the Cursor
          // desktop app while its CLI is `cursor-agent`. Let the runtime build the
          // configured launcher instead of executing the raw id.
          startupAgent: args.agent,
          ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
          title: `worker-${args.taskId}`,
          // Why: dispatching a worker is background work; it must not pull the sidebar
          // to the worker's workspace while the user is reading somewhere else.
          surfaceOwner: false
        })
  args.effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning
  })
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_created',
    worktreeId: args.worktreeId,
    terminalHandle: terminal.handle,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
  if (args.interactiveAgentCommand) {
    // The visible background-terminal path can adopt a shell before its startup
    // command is delivered. Explicit injection makes the supervised launch
    // observable and keeps the later Dispatch prompt inside the ZCode TUI.
    await launchInteractiveAgent(
      args.runtime,
      terminal.handle,
      args.agent,
      args.interactiveAgentCommand
    )
  }
  return {
    handle: terminal.handle,
    warning: terminal.warning,
    promptDelivery: startupCommandPrompt ? 'startup-command' : 'agent-input'
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
  promptDelivery: 'agent-input' | 'startup-command'
  interactiveAgentCommand?: string
  effects: WorkerEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
  setupReceipt: WorkerSetupReceipt
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  db.recordWorkerStage({ dispatchId, stage: 'worktree_creating', effects })
  const created = await runtime.createManagedWorktree({
    repoSelector: params.repo ?? coordinatorWorktree.repoId,
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
    ...(args.promptDelivery === 'startup-command' || args.interactiveAgentCommand
      ? { deferStartupAgent: true }
      : {}),
    ...(args.interactiveAgentCommand ? { bareDeferredAgentShell: true } : {}),
    ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {}),
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
  effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'reused_agent_terminal',
    id: terminalHandle
  })
  db.recordWorkerStage({
    dispatchId,
    stage: 'terminal_created',
    worktreeId: created.worktree.id,
    terminalHandle,
    effects,
    residualResources: residualWorkerEffects(effects)
  })
  if (args.interactiveAgentCommand) {
    await launchInteractiveAgent(runtime, terminalHandle, args.agent, args.interactiveAgentCommand)
  }
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
  const setupTerminalHandle = created.setupReceipt?.terminalHandle
  for (const terminal of listed.terminals) {
    const terminalEffect = {
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
    } satisfies WorkerEffect
    const existingEffect = effects.find(
      (effect) => effect.kind === 'terminal' && effect.id === terminal.handle
    )
    if (existingEffect) {
      Object.assign(existingEffect, terminalEffect)
    } else {
      effects.push(terminalEffect)
    }
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
}
