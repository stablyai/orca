/**
 * Where a worker's agent comes from: the terminal the caller passed, or a fresh launch through the
 * shared executor — into a worktree this start creates or into an existing one.
 *
 * The executor owns the sequencing: a structured worker's worktree is created with no startup
 * agent, the host is then asked about the workspace that now exists, and only then is the session
 * created. What stays here is what makes it a worker: the worktree is created with the dispatch's
 * lineage and effects, and the surface is a background session or a `worker-<task>` terminal that
 * does not take the sidebar. The mode was decided before the dispatch record existed, so it is
 * handed in rather than decided again.
 *
 * A refused structured session fails the start: the worker factory throws its own error, never the
 * executor's downgrade signal, so a dispatch that asked for a chat does not quietly get a terminal.
 */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { executeAgentLaunch } from '../../../../../agent-launch/agent-launch-executor'
import type { AgentLaunchSurfaceFactory } from '../../../../../agent-launch/agent-launch-surface-factories'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  WORKER_START_VOCABULARY,
  type WorkerStartModeReceipt
} from '../../orchestration-worker-start-mode'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
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
  /** Decided before the dispatch record; for an existing worktree, already settled on its host. */
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
  const existing = args.creationWorktree ? undefined : requireWorktree(args.resolvedWorktree)
  if (existing && args.params.terminal) {
    args.effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'reused',
      id: args.params.terminal
    })
    return {
      mode: args.mode,
      worktree: existing,
      terminalHandle: args.params.terminal,
      structuredSession: null,
      setupReceipt: EXISTING_WORKTREE_SETUP
    }
  }
  return launchWorkerAgent(args, existing)
}

async function launchWorkerAgent(
  args: WorkerAgentPlacementArgs,
  existing: PlacedWorktree | undefined
): Promise<WorkerAgentPlacement> {
  const agent = requireAgent(args.agent)
  let created: Awaited<ReturnType<typeof createWorkerWorktree>> | undefined
  let structuredSession: WorkerStructuredSession | null = null
  let launched: Awaited<ReturnType<typeof executeAgentLaunch>>
  try {
    launched = await executeAgentLaunch({
      runtime: args.runtime,
      intent: {
        agent,
        // The worker's own factory builds the create from the dispatch, so the target carries none.
        target: existing
          ? { kind: 'existing', worktree: existing.id }
          : { kind: 'create-worktree', create: {} },
        launchSource: 'orchestration'
      },
      decidedMode: args.mode,
      vocabulary: WORKER_START_VOCABULARY,
      onStage: (stage) =>
        args.onStage(stage === 'worktree_create' ? 'worktree_create' : 'terminal_create'),
      workspaces: {
        createWorktree: async ({ startupAgent }) => {
          created = await createWorkerWorktree({
            runtime: args.runtime,
            db: args.db,
            dispatchId: args.dispatchId,
            requestedWorktree: args.requestedWorktree,
            coordinatorWorktree: requireWorktree(args.creationWorktree),
            params: args.params,
            agent,
            // The executor withholds the startup agent exactly when the worker is to be a session.
            withAgentTerminal: startupAgent !== undefined,
            ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
            effects: args.effects
          })
          return {
            worktreeId: created.worktree.id,
            startupTerminalHandle: created.terminalHandle
          }
        }
      },
      surfaces: workerSurfaceFactory(args, agent, (session) => {
        structuredSession = session
      })
    })
  } catch (error) {
    // The caller only sees a returned placement, so a session made before this throw is ours.
    await tearDownFailedWorkerStart({
      runtime: args.runtime,
      structuredSession,
      dispatchId: args.dispatchId
    })
    throw error
  }
  return {
    mode: launched.receipt,
    worktree: existing ?? requireWorktree(created?.worktree),
    terminalHandle: launched.outcome.handle,
    structuredSession,
    setupReceipt: created?.setupReceipt ?? EXISTING_WORKTREE_SETUP,
    ...(launched.warning ? { warning: launched.warning } : {})
  }
}

/** A worker's surface in a worktree that exists: a background session with the dispatch's redrive
 *  and mailbox, or a `worker-<task>` terminal that leaves the sidebar where the user has it. */
function workerSurfaceFactory(
  args: WorkerAgentPlacementArgs,
  agent: TuiAgent,
  onStructuredSession: (session: WorkerStructuredSession) => void
): AgentLaunchSurfaceFactory {
  const recordSurfaceStage = (worktreeId: string): void => {
    args.db.recordWorkerStage({
      dispatchId: args.dispatchId,
      stage: 'terminal_creating',
      worktreeId,
      effects: args.effects
    })
  }
  return {
    createStructuredSession: async ({ worktreeId }) => {
      recordSurfaceStage(worktreeId)
      const session = await createStructuredWorkerSessionForWorktree({
        runtime: args.runtime,
        worktreeId,
        agent,
        dispatchId: args.dispatchId,
        ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
        effects: args.effects
      })
      onStructuredSession(session)
      return {
        sessionId: session.identity.sessionId,
        handle: session.identity.handle,
        fence: session.fence
      }
    },
    createTerminalAgent: async ({ worktreeId }) => {
      recordSurfaceStage(worktreeId)
      const terminal = await createExistingWorktreeWorkerTerminal({
        runtime: args.runtime,
        worktreeId,
        agent,
        ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
        taskId: args.taskId,
        effects: args.effects
      })
      return { handle: terminal.handle, ...(terminal.warning ? { warning: terminal.warning } : {}) }
    }
  }
}

function requireWorktree(worktree: PlacedWorktree | undefined): PlacedWorktree {
  if (!worktree) {
    throw new Error('Worker topology did not resolve a worktree.')
  }
  return worktree
}

/** Validation refuses a fresh launch with no agent; this only narrows the type. */
function requireAgent(agent: TuiAgent | undefined): TuiAgent {
  if (!agent) {
    throw new Error('Worker topology did not resolve an agent.')
  }
  return agent
}
