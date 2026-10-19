/**
 * A federated worker's agent, started by the host that runs it through the shared executor.
 *
 * The receiving host owns execution, and federation creates terminal agents only, so the launch is
 * `terminalOnly`. What makes it federation's is in the factories: a new top-level worktree created
 * agent-first with the attachment's stages and effects, or a background `worker-<task>` terminal in
 * an existing one. The dispatch brief is a later turn, outside the launch.
 */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { executeAgentLaunch } from '../../../../../agent-launch/agent-launch-executor'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { WORKER_START_VOCABULARY } from '../../orchestration-worker-start-mode'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './federation-effects'
import type { FederationAttachStartInput } from './federation-start-schema'

const TERMINAL_ONLY_MESSAGE = 'A federated worker starts a terminal agent only.'

export async function launchFederatedWorkerAgent(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: FederationAttachStartInput
  agent: TuiAgent | undefined
  launchPreferences: AgentLaunchPreferences | undefined
  /** The workspace to start in; absent creates the new top-level worktree the params describe. */
  worktree?: { id: string }
  setupSource: string
  effects: FederationEffect[]
  /** The created worktree's setup receipt, as soon as it exists, so a later failure reports it. */
  onSetup: (setup: WorkerSetupReceipt) => void
  onStage: (stage: 'worktree_create' | 'terminal_create') => void
}): Promise<{ worktree: { id: string }; terminalHandle: string }> {
  const { runtime, db, params, effects } = args
  if (!args.agent) {
    // Validation refuses a fresh launch with no agent; this only narrows the type.
    throw new Error(
      'A configured --agent is required when federated worker-start creates a terminal.'
    )
  }
  const agent = args.agent
  let created: { id: string } | undefined
  const launched = await executeAgentLaunch({
    runtime,
    intent: {
      agent,
      // Federation's own factory builds the create from the attachment, so the target carries none.
      target: args.worktree
        ? { kind: 'existing', worktree: args.worktree.id }
        : { kind: 'create-worktree', create: {} },
      launchSource: 'orchestration'
    },
    terminalOnly: true,
    vocabulary: WORKER_START_VOCABULARY,
    onStage: (stage) =>
      args.onStage(stage === 'worktree_create' ? 'worktree_create' : 'terminal_create'),
    workspaces: {
      createWorktree: async ({ startupAgent }) => {
        // Agent-first is the only create here; a structured pre-flight must not reach it.
        if (startupAgent === undefined) {
          throw new Error(TERMINAL_ONLY_MESSAGE)
        }
        const { repo, name } = params
        if (!repo || !name) {
          // Validation refuses this before the attachment exists; this only narrows the types.
          throw new Error('A remote new-top-level worktree requires --name and an explicit --repo.')
        }
        db.recordRemoteAttachmentStage({
          dispatchId: params.dispatchId,
          stage: 'worktree_creating'
        })
        const setupDecision = params.setup ?? 'run'
        const result = await runtime.createManagedWorktree({
          repoSelector: repo,
          name,
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
          startupAgent: agent,
          startupLaunchSource: 'orchestration',
          ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {}),
          activate: false,
          lineage: { noParent: true }
        })
        created = result.worktree
        const terminalHandle = result.startupTerminal?.handle
        effects.push({ kind: 'worktree', action: 'created_top_level', id: result.worktree.id })
        const setup: WorkerSetupReceipt = {
          requested: setupDecision,
          effective: setupDecision,
          source: args.setupSource,
          hookFound: result.setupReceipt?.hookFound ?? false,
          startupPolicy: result.setupReceipt?.startupPolicy ?? 'start-immediately',
          state: result.setupReceipt?.state ?? 'not_configured'
        }
        args.onSetup(setup)
        if (!terminalHandle) {
          throw new Error(result.warning ?? 'Agent-first worktree creation returned no terminal.')
        }
        const listed = await runtime.listTerminals(`id:${result.worktree.id}`, undefined, {
          includeVisualLayouts: false
        })
        appendFederationTerminalEffects(
          effects,
          listed.terminals,
          terminalHandle,
          result.setupReceipt?.terminalHandle
        )
        appendFederationSetupEffect(effects, setup)
        return { worktreeId: result.worktree.id, startupTerminalHandle: terminalHandle }
      }
    },
    surfaces: {
      createStructuredSession: () => {
        throw new Error(TERMINAL_ONLY_MESSAGE)
      },
      createTerminalAgent: async ({ worktreeId }) => {
        const terminal = await runtime.createTerminal(`id:${worktreeId}`, {
          // Why: agent ids are not shell commands (`cursor` is the desktop app,
          // its CLI is `cursor-agent`); resolve through the TUI agent config.
          startupAgent: agent,
          launchSource: 'orchestration',
          ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
          title: `worker-${params.taskId}`,
          presentation: 'background'
        })
        effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: terminal.handle })
        return { handle: terminal.handle }
      }
    }
  })
  const worktree = args.worktree ?? created
  if (!worktree) {
    throw new Error('Federated worker topology did not resolve.')
  }
  return { worktree, terminalHandle: launched.outcome.handle }
}
