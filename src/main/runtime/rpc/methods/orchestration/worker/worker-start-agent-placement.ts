/**
 * Where a worker's agent comes from: a worktree this start creates, a structured session, a new
 * terminal in an existing worktree, or the terminal the caller passed.
 *
 * A structured worker never takes the agent-first worktree path. `createWorkerWorktree` used to be
 * the only way a new worktree was made, and it creates one WITH its startup agent terminal, which
 * left the structured branch below it unreachable for every `--worktree new-child` dispatch. Here
 * the worktree is created without a startup agent and the structured session is created for it
 * afterwards — the same order the renderer's own structured worktree create uses.
 *
 * That reorder is also why the host verdict lands here: `agentSession.createSupport` can only be
 * asked about a workspace that exists, so for a created worktree it cannot run before the start.
 * A refusal becomes a terminal agent in the worktree that was just created, never a failed start.
 */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  resolveWorkerStartModeOnHost,
  type WorkerStartModeReceipt
} from '../../orchestration-worker-start-mode'
import type { WorkerStartInput } from './worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createStructuredWorkerSessionForWorktree,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'
import { createWorkerWorktree } from './worker-worktree-creation'

/** Only what the placement itself reads. The runtime's own worktree accessors are untyped, so
 *  naming the two fields keeps `any` out of this module's unions. */
type PlacedWorktree = { id: string; repoId: string }
type WorkerStructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>>

export type WorkerAgentPlacement = {
  /** The mode that actually ran; a created worktree can settle it later than the caller could. */
  mode: WorkerStartModeReceipt
  worktree: PlacedWorktree
  terminalHandle: string
  structuredSession: WorkerStructuredSession | null
  setupReceipt: WorkerSetupReceipt
  warning?: string
}

type WorkerAgentPlacementArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  taskId: string
  params: WorkerStartInput
  requestedWorktree: string
  /** The coordinator's worktree, present only when this start creates one. */
  creationWorktree: PlacedWorktree | undefined
  /** The already-resolved placement, present only when this start does not create one. */
  resolvedWorktree: PlacedWorktree | undefined
  mode: WorkerStartModeReceipt
  agent: TuiAgent | undefined
  launchPreferences: AgentLaunchPreferences | undefined
  effects: WorkerEffect[]
  /** Attributes a throw to the step that was running, the way the caller's own stages do. */
  onStage: (stage: string) => void
}

/** The setup receipt for a placement that creates no worktree, and the one a start reports if it
 *  fails before a placement exists. */
export const EXISTING_WORKTREE_SETUP: WorkerSetupReceipt = {
  requested: 'not_applicable',
  effective: 'not_applicable',
  source: 'existing_worktree',
  hookFound: false,
  startupPolicy: 'start-immediately',
  state: 'not_applicable'
}

export async function placeWorkerAgent(
  args: WorkerAgentPlacementArgs
): Promise<WorkerAgentPlacement> {
  if (args.creationWorktree) {
    return placeInCreatedWorktree(args, args.creationWorktree)
  }
  const worktree = requireWorktree(args.resolvedWorktree)
  if (args.params.terminal) {
    args.effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'reused',
      id: args.params.terminal
    })
    return {
      mode: args.mode,
      worktree,
      terminalHandle: args.params.terminal,
      structuredSession: null,
      setupReceipt: EXISTING_WORKTREE_SETUP
    }
  }
  return {
    mode: args.mode,
    worktree,
    ...(await createWorkerAgentSurface(args, worktree.id, args.mode)),
    setupReceipt: EXISTING_WORKTREE_SETUP
  }
}

async function placeInCreatedWorktree(
  args: WorkerAgentPlacementArgs,
  coordinatorWorktree: PlacedWorktree
): Promise<WorkerAgentPlacement> {
  args.onStage('worktree_create')
  const created = await createWorkerWorktree({
    runtime: args.runtime,
    db: args.db,
    dispatchId: args.dispatchId,
    requestedWorktree: args.requestedWorktree,
    coordinatorWorktree,
    params: args.params,
    agent: args.agent as TuiAgent,
    withAgentTerminal: args.mode.mode !== 'structured',
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    effects: args.effects
  })
  const worktree = requireWorktree(created.worktree)
  if (args.mode.mode !== 'structured') {
    return {
      mode: args.mode,
      worktree,
      terminalHandle: requireTerminal(created.terminalHandle),
      structuredSession: null,
      setupReceipt: created.setupReceipt
    }
  }
  args.onStage('terminal_create')
  const mode = await resolveWorkerStartModeOnHost(args.runtime, args.mode, worktree.id, args.agent)
  return {
    mode,
    worktree,
    ...(await createWorkerAgentSurface(args, worktree.id, mode)),
    setupReceipt: created.setupReceipt
  }
}

/** The agent surface for a worktree that exists; the settled mode picks which one. */
async function createWorkerAgentSurface(
  args: WorkerAgentPlacementArgs,
  worktreeId: string,
  mode: WorkerStartModeReceipt
): Promise<Pick<WorkerAgentPlacement, 'terminalHandle' | 'structuredSession' | 'warning'>> {
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_creating',
    worktreeId,
    effects: args.effects
  })
  if (mode.mode === 'structured') {
    const structuredSession = await createStructuredWorkerSessionForWorktree({
      runtime: args.runtime,
      worktreeId,
      agent: args.agent as TuiAgent,
      dispatchId: args.dispatchId,
      ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
      effects: args.effects
    })
    return { terminalHandle: structuredSession.identity.handle, structuredSession }
  }
  const terminal = await createExistingWorktreeWorkerTerminal({
    runtime: args.runtime,
    worktreeId,
    agent: args.agent as TuiAgent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    taskId: args.taskId,
    effects: args.effects
  })
  return {
    terminalHandle: terminal.handle,
    structuredSession: null,
    ...(terminal.warning ? { warning: terminal.warning } : {})
  }
}

function requireWorktree(worktree: PlacedWorktree | undefined): PlacedWorktree {
  if (!worktree) {
    throw new Error('Worker topology did not resolve a worktree.')
  }
  return worktree
}

function requireTerminal(terminalHandle: string | undefined): string {
  if (!terminalHandle) {
    throw new Error('Worker topology did not resolve an agent terminal.')
  }
  return terminalHandle
}
