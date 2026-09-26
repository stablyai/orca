/**
 * Creating the worktree a federated `new-top-level` dispatch asks for, the remote counterpart of
 * `worker-worktree-creation.ts`.
 *
 * The worktree is created agent-first, so the startup terminal IS the worker. It is recorded on the
 * attachment row the moment it exists: everything after that point can throw, and a failed attach
 * still has to name what this host was left holding.
 *
 * `setup` is filled in place rather than returned, because the caller reports it from its own catch
 * block — the same reason `applyWaitForSetupOutcome` mutates it.
 */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './federation-effects'
import { persistFederatedWorktreeCreation } from './federation-setup'
import type { FederationAttachStartInput } from './federation-start-schema'

export async function createFederatedWorkerWorktree(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: FederationAttachStartInput
  agent: TuiAgent | undefined
  launchPreferences: AgentLaunchPreferences | undefined
  setup: WorkerSetupReceipt
  effects: FederationEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>['worktree']
  terminalHandle: string
}> {
  const { runtime, db, params, setup, effects } = args
  db.recordRemoteAttachmentStage({ dispatchId: params.dispatchId, stage: 'worktree_creating' })
  const setupDecision = params.setup ?? 'run'
  const created = await runtime.createManagedWorktree({
    repoSelector: params.repo as string,
    name: params.name as string,
    baseBranch: params.baseBranch,
    displayName: params.displayName,
    displayNameKind: params.displayNameKind,
    comment: params.comment,
    // setupDecision runs setup without the legacy runHooks activation side effect.
    runHooks: false,
    setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    createdWithAgent: args.agent,
    startupAgent: args.agent,
    ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {}),
    activate: false,
    lineage: { noParent: true }
  })
  effects.push({ kind: 'worktree', action: 'created_top_level', id: created.worktree.id })
  persistFederatedWorktreeCreation({
    db,
    dispatchId: params.dispatchId,
    worktreeId: created.worktree.id,
    effects
  })
  setup.requested = setupDecision
  setup.effective = setupDecision
  setup.hookFound = created.setupReceipt?.hookFound ?? false
  setup.startupPolicy = created.setupReceipt?.startupPolicy ?? 'start-immediately'
  setup.state = created.setupReceipt?.state ?? 'not_configured'
  const terminalHandle = created.startupTerminal?.handle
  if (!terminalHandle) {
    throw new Error(created.warning ?? 'Agent-first worktree creation returned no terminal.')
  }
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
  appendFederationTerminalEffects(
    effects,
    listed.terminals,
    terminalHandle,
    created.setupReceipt?.terminalHandle
  )
  appendFederationSetupEffect(effects, setup)
  return { worktree: created.worktree, terminalHandle }
}
