import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
/** Launch on the receiving host in the mode it decided, with federation's worktree, background-terminal and
 *  chat-session factories. The dispatch brief is delivered later. */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { executeAgentLaunch } from '../../../../../agent-launch/agent-launch-executor'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { WORKER_START_VOCABULARY } from '../structured-workers/orchestration-worker-start-mode'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import { resolveWorkerWorktreeName } from '../worker/worker-worktree-creation'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './federation-effects'
import type { FederationAttachStartInput } from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentLaunchModeReceipt } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { createStructuredWorkerSessionForWorktree } from '../worker/worker-topology'
import { tearDownFailedWorkerStart } from '../worker/failed-worker-start-teardown'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>>

export async function launchFederatedWorkerAgent(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: FederationAttachStartInput
  agent: TuiAgent | undefined
  launchPreferences: AgentLaunchPreferences | undefined
  /** Decided here, on the host that runs the worker, from this host's own settings. */
  mode: AgentLaunchModeReceipt
  /** The workspace to start in; absent creates the new top-level worktree the params describe. */
  worktree?: { id: string }
  /** The paired client that asked, so its own sidebar counts the new worktree as its own. */
  creatorProvenance?: Worktree['creatorProvenance']
  setupSource: string
  effects: FederationEffect[]
  /** The created worktree's setup receipt, as soon as it exists, so a later failure reports it. */
  onSetup: (setup: WorkerSetupReceipt) => void
  onStage: (stage: 'worktree_create' | 'terminal_create') => void
}): Promise<{
  worktree: { id: string }
  terminalHandle: string
  terminalCreation?: RuntimeTerminalCreate
  /** Set when the worker is a chat session rather than a terminal agent. */
  structuredSession: StructuredSession | null
  /** The mode that actually ran; a created worktree can settle it later than the caller could. */
  mode: AgentLaunchModeReceipt
}> {
  const { runtime, db, params, effects } = args
  if (!args.agent) {
    // Validation refuses a fresh launch with no agent; this only narrows the type.
    throw new Error(
      'A configured --agent is required when federated worker-start creates a terminal.'
    )
  }
  const agent = args.agent
  let created: { id: string } | undefined
  let terminalCreation: RuntimeTerminalCreate | undefined
  let structuredSession: StructuredSession | null = null
  let launched: Awaited<ReturnType<typeof executeAgentLaunch>>
  try {
    launched = await executeAgentLaunch({
      runtime,
      intent: {
        agent,
        // Federation's own factory builds the create from the attachment, so the target carries none.
        target: args.worktree
          ? { kind: 'existing', worktree: args.worktree.id }
          : { kind: 'create-worktree', create: {} },
        launchSource: 'orchestration'
      },
      decidedMode: args.mode,
      vocabulary: WORKER_START_VOCABULARY,
      onStage: (stage) =>
        args.onStage(stage === 'worktree_create' ? 'worktree_create' : 'terminal_create'),
      workspaces: {
        createWorktree: async ({ startupAgent, promisedAgentChat, onWorkspaceCreated }) => {
          const { repo } = params
          if (!repo) {
            // Validation refuses this before the attachment exists; this only narrows the types.
            throw new Error('A remote new-top-level worktree requires an explicit --repo.')
          }
          db.recordRemoteAttachmentStage({
            dispatchId: params.dispatchId,
            stage: 'worktree_creating'
          })
          const setupDecision = params.setup ?? 'run'
          const result = await runtime.createManagedWorktree({
            onStartupTerminalCreated: (terminal) => {
              terminalCreation = terminal
            },
            repoSelector: repo,
            ...(await resolveWorkerWorktreeName(runtime, repo, params.name)),
            baseBranch: params.baseBranch,
            displayName: params.displayName,
            displayNameKind: params.displayNameKind,
            comment: params.comment,
            // setupDecision runs setup without the legacy runHooks activation side effect.
            runHooks: false,
            setupDecision,
            awaitTerminalProvisioning: true,
            observeSetupCompletion: true,
            createdWithAgent: agent,
            ...(promisedAgentChat ? { promisedAgentChat: true } : {}),
            ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
            // The executor withholds the startup agent exactly when the worker is to be a chat session.
            ...(startupAgent !== undefined
              ? {
                  startupAgent: agent,
                  startupLaunchSource: 'orchestration' as const,
                  startupSuppressUpdatePrompt: true,
                  ...(args.launchPreferences
                    ? { startupLaunchPreferences: args.launchPreferences }
                    : {})
                }
              : {}),
            activate: false,
            ...(args.creatorProvenance ? { creatorProvenance: args.creatorProvenance } : {}),
            lineage: params.crossStoreParent
              ? {
                  crossStoreParent: params.crossStoreParent,
                  ...(params.crossStoreParentInferredFrom
                    ? { crossStoreParentInferredFrom: params.crossStoreParentInferredFrom }
                    : {})
                }
              : { noParent: true }
          })
          created = result.worktree
          const terminalHandle = result.startupTerminal?.handle
          effects.push({
            kind: 'worktree',
            action: params.crossStoreParent ? 'created_child' : 'created_top_level',
            id: result.worktree.id,
            name: result.worktree.displayName
          })
          const setup: WorkerSetupReceipt = {
            requested: setupDecision,
            effective: setupDecision,
            source: args.setupSource,
            hookFound: result.setupReceipt?.hookFound ?? false,
            startupPolicy: result.setupReceipt?.startupPolicy ?? 'start-immediately',
            state: result.setupReceipt?.state ?? 'not_configured'
          }
          args.onSetup(setup)
          // A chat has no startup terminal; its setup terminal is still recorded so the setup gate finds it.
          const chat = startupAgent === undefined
          if (!chat && !terminalHandle) {
            throw new Error(result.warning ?? 'Agent-first worktree creation returned no terminal.')
          }
          const listed = await runtime.listTerminals(`id:${result.worktree.id}`, undefined, {
            includeVisualLayouts: false
          })
          appendFederationTerminalEffects(
            effects,
            listed.terminals,
            chat ? undefined : terminalHandle,
            result.setupReceipt?.terminalHandle
          )
          appendFederationSetupEffect(effects, setup)
          return {
            worktreeId: result.worktree.id,
            startupTerminalHandle: chat ? undefined : terminalHandle
          }
        }
      },
      surfaces: {
        createStructuredSession: async ({ worktreeId }) => {
          args.onStage('terminal_create')
          structuredSession = await createStructuredWorkerSessionForWorktree({
            runtime,
            worktreeId,
            agent,
            dispatchId: params.dispatchId,
            ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
            effects
          })
          return {
            sessionId: structuredSession.identity.sessionId,
            handle: structuredSession.identity.handle,
            fence: structuredSession.fence
          }
        },
        createTerminalAgent: async ({ worktreeId }) => {
          const terminal = await runtime.createTerminal(`id:${worktreeId}`, {
            // Resolve agent ids through TUI config: cursor is the desktop app, its CLI is cursor-agent.
            startupAgent: agent,
            launchSource: 'orchestration',
            suppressStartupUpdatePrompt: true,
            ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
            title: `worker-${params.taskId}`,
            presentation: 'background'
          })
          effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: terminal.handle })
          terminalCreation = terminal
          return { handle: terminal.handle, terminalCreation: terminal }
        }
      }
    })
  } catch (error) {
    // The caller only sees a returned launch, so a session made before this throw is ours.
    await tearDownFailedWorkerStart({
      runtime,
      structuredSession,
      dispatchId: params.dispatchId,
      error
    })
    throw error
  }
  const worktree = args.worktree ?? created
  if (!worktree) {
    throw new Error('Federated worker topology did not resolve.')
  }
  return {
    worktree,
    terminalHandle: launched.outcome.handle,
    terminalCreation,
    structuredSession,
    mode: launched.receipt
  }
}
