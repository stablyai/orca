import { createHash, randomUUID } from 'node:crypto'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import { persistWorkerReadinessStage } from './orchestration-worker-setup-gate'

export type ArgvWorkerTerminal = {
  handle: string
  tabId?: string
  paneKey?: string | null
  ptyId?: string | null
  surface?: 'background' | 'visible'
  warning?: string
}

export type ArgvWorktreeLaunch = {
  startupLaunchToken: string
  startupPreAllocatedHandle: string
  buildStartupPrompt: (cliCommand: 'orca' | 'orca-ide') => string
  assertTerminalHandle: (terminalHandle: string) => void
  persistAgentTerminalOwnership: (
    terminal: ArgvWorkerTerminal,
    setupReceipt: WorkerSetupReceipt,
    worktreeId: string
  ) => void
}

export function createArgvLaunchCredentials(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  task: { id: string; spec: string }
  dispatchId: string
  coordinatorHandle: string
  devMode?: boolean
}): Pick<
  ArgvWorktreeLaunch,
  'startupLaunchToken' | 'startupPreAllocatedHandle' | 'buildStartupPrompt'
> {
  const preAllocatedHandle = args.runtime.createPreAllocatedTerminalHandle()
  const launchToken = randomUUID()
  args.db.commitDispatchLaunchTokenHash(
    args.dispatchId,
    createHash('sha256').update(launchToken).digest('hex')
  )
  const dispatchCapability = args.db.mintStartingWorkerCapability({
    dispatchId: args.dispatchId
  })
  return {
    startupLaunchToken: launchToken,
    startupPreAllocatedHandle: preAllocatedHandle,
    buildStartupPrompt: (cliCommand) =>
      buildDispatchPreamble({
        taskId: args.task.id,
        dispatchId: args.dispatchId,
        taskSpec: args.task.spec,
        coordinatorHandle: args.coordinatorHandle,
        workerHandle: preAllocatedHandle,
        dispatchCapability,
        devMode: args.devMode,
        cliCommand
      })
  }
}

export async function bindAndMarkArgvWorkerReady(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  terminalHandle: string
  worktreeId: string
  effects: WorkerEffect[]
  setupReceipt: WorkerSetupReceipt
  terminalOwnership: 'created' | 'external'
  task: { id: string; spec: string }
  coordinatorHandle: string
  devMode?: boolean
}) {
  await attachWorkerAuthority({
    runtime: args.runtime,
    db: args.db,
    dispatchId: args.dispatchId,
    terminalHandle: args.terminalHandle,
    worktreeId: args.worktreeId,
    effects: args.effects,
    setupState: args.setupReceipt.state,
    terminalOwnership: args.terminalOwnership,
    task: args.task,
    coordinatorHandle: args.coordinatorHandle,
    devMode: args.devMode,
    argv: true
  })
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: 'accepted'
  })
  const worker = args.db.markWorkerDispatchReady(args.dispatchId, args.effects)
  monitorWorkerSetup({
    runtime: args.runtime,
    db: args.db,
    runId: args.runId,
    dispatchId: args.dispatchId,
    setupReceipt: args.setupReceipt,
    effects: args.effects
  })
  return worker
}

export function createArgvWorktreeLaunch(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  task: { id: string; spec: string }
  dispatchId: string
  coordinatorHandle: string
  devMode?: boolean
  effects: WorkerEffect[]
}): ArgvWorktreeLaunch {
  const credentials = createArgvLaunchCredentials(args)
  return {
    ...credentials,
    assertTerminalHandle: (terminalHandle) => {
      if (terminalHandle !== credentials.startupPreAllocatedHandle) {
        throw new Error(
          `Worker terminal adopted handle ${terminalHandle} instead of the pre-allocated ${credentials.startupPreAllocatedHandle}.`
        )
      }
    },
    persistAgentTerminalOwnership: (terminal, setupReceipt, worktreeId) =>
      persistArgvWorkerTerminalOwnership({
        runtime: args.runtime,
        db: args.db,
        dispatchId: args.dispatchId,
        worktreeId,
        terminal,
        setupReceipt,
        effects: args.effects
      })
  }
}

export function persistArgvWorkerTerminalOwnership(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  terminal: ArgvWorkerTerminal
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const { runtime, db, effects, terminal } = args
  effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning
  })
  const terminalAuthority = runtime.getOrchestrationDispatchAuthority(terminal.handle)
  persistWorkerReadinessStage({
    db,
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    terminalHandle: terminal.handle,
    setup: args.setupReceipt,
    effects
  })
  if (!db.getWorkerTerminalResourceByOwner(args.dispatchId)) {
    db.createWorkerTerminalResourceStatement({
      dispatchId: args.dispatchId,
      worktreeId: args.worktreeId,
      terminalHandle: terminal.handle,
      paneKey:
        terminal.paneKey ??
        terminalAuthority?.paneKey ??
        runtime.getTerminalPaneKey(terminal.handle),
      processIncarnation:
        terminalAuthority?.processIncarnation ??
        runtime.getTerminalProcessIncarnation(terminal.handle),
      hostScope: terminalAuthority?.hostScope ? JSON.stringify(terminalAuthority.hostScope) : null,
      ownership: 'owned'
    })
  }
}

export function resolveArgvWorktreeLaunch(args: {
  creationWorktree: boolean
  agent?: TuiAgent
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  task: { id: string; spec: string }
  dispatchId: string
  coordinatorHandle: string
  devMode?: boolean
  effects: WorkerEffect[]
}): ArgvWorktreeLaunch | undefined {
  if (!args.creationWorktree || !args.agent) {
    return undefined
  }
  if (TUI_AGENT_CONFIG[args.agent].promptInjectionMode !== 'argv') {
    return undefined
  }
  return createArgvWorktreeLaunch(args)
}

export async function attachWorkerAuthority(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  worktreeId: string
  effects: WorkerEffect[]
  setupState: string
  terminalOwnership: 'created' | 'external'
  task: { id: string; spec: string }
  coordinatorHandle: string
  devMode?: boolean
  argv: boolean
}): Promise<void> {
  const terminalAuthority = requireWorkerAuthority(args.runtime, args.terminalHandle)
  if (args.argv) {
    args.db.bindStartingWorkerAuthority({
      dispatchId: args.dispatchId,
      handle: args.terminalHandle,
      ...terminalAuthority,
      worktreeId: args.worktreeId,
      effects: args.effects,
      setupState: args.setupState,
      terminalOwnership: args.terminalOwnership
    })
    return
  }
  const capability = args.db.prepareStartingWorkerAuthority({
    dispatchId: args.dispatchId,
    handle: args.terminalHandle,
    ...terminalAuthority,
    worktreeId: args.worktreeId,
    effects: args.effects,
    setupState: args.setupState,
    terminalOwnership: args.terminalOwnership
  })
  const preamble = buildDispatchPreamble({
    taskId: args.task.id,
    dispatchId: args.dispatchId,
    taskSpec: args.task.spec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: args.terminalHandle,
    dispatchCapability: capability,
    devMode: args.devMode,
    cliCommand: args.runtime.getTerminalOrchestrationCliCommand(args.terminalHandle)
  })
  await args.runtime.sendTerminalAgentPrompt(args.terminalHandle, preamble)
}
