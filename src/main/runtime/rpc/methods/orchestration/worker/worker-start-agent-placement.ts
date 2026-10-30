/** Use the shared executor for new workers; structured worktrees omit startup agent, then resolve host support before chat creation.
 * Keep worker lineage/effects and background presentation in factories; caller passes the pre-decided mode.
 * Structured create refusals fail start through the worker error contract instead of silently downgrading. */

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
import { createWorkerWorktree, type WorkerWorktreeCreationTarget } from './worker-worktree-creation'

/** Name only the two required fields so untyped worktree accessors cannot introduce any into unions. */
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
  /** Present only when this start creates a worktree. */
  creationTarget: WorkerWorktreeCreationTarget | undefined
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

/** Setup evidence for existing placements and failures before placement creation. */
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
  const existing = args.creationTarget ? undefined : requirePlacement(args.resolvedWorktree)
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
        createRecoveryShell: async (worktreeId) => {
          const shell = await args.runtime.createTerminal(`id:${worktreeId}`, {
            surfaceOwner: false
          })
          args.effects.push({
            kind: 'terminal',
            role: 'recovery_shell',
            action: 'created',
            id: shell.handle,
            tabId: shell.tabId
          })
        },
        createWorktree: async ({ startupAgent, promisedAgentChat, onWorkspaceCreated }) => {
          created = await createWorkerWorktree({
            runtime: args.runtime,
            db: args.db,
            dispatchId: args.dispatchId,
            requestedWorktree: args.requestedWorktree,
            target: requirePlacement(args.creationTarget),
            params: args.params,
            agent,
            // The executor withholds the startup agent exactly when the worker is to be a session.
            withAgentTerminal: startupAgent !== undefined,
            promisedAgentChat,
            onWorkspaceCreated,
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
    worktree: existing ?? requirePlacement(created?.worktree),
    terminalHandle: launched.outcome.handle,
    structuredSession,
    setupReceipt: created?.setupReceipt ?? EXISTING_WORKTREE_SETUP,
    ...(launched.warning ? { warning: launched.warning } : {})
  }
}

/** Create worker-specific background chat/redrive/mailbox or worker-task terminal without moving the sidebar. */
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

function requirePlacement<T>(placement: T | undefined): T {
  if (!placement) {
    throw new Error('Worker topology did not resolve a placement.')
  }
  return placement
}

function requireAgent(agent: TuiAgent | undefined): TuiAgent {
  if (!agent) {
    throw new Error('Worker topology did not resolve an agent.')
  }
  return agent
}
