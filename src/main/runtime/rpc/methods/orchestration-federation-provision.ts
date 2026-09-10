import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './orchestration/federation/federation-effects'
import type { WorkerSetupReceipt } from './orchestration/worker/worker-topology'
import type { prepareFederationAttachmentWorkerStart } from './orchestration/worker/worker-start-validation'
import type { FederationAttachStartInput } from './orchestration/federation/federation-start-schema'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

type ProvisionArgs = {
  params: FederationAttachStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  createsWorktree: boolean
  agent: TuiAgent | undefined
  launch: ReturnType<typeof prepareFederationAttachmentWorkerStart>['launch']
  leaseTitle: string
  effects: FederationEffect[]
  setup: WorkerSetupReceipt
  terminalHandle: string | undefined
  setupSource: string
  setStage: (stage: string) => void
}

/** Creates or reuses the worker workspace and its agent terminal for one federated attach. */
export async function provisionFederatedWorkerWorkspace(args: ProvisionArgs) {
  const {
    params,
    runtime,
    db,
    createsWorktree,
    agent,
    launch,
    leaseTitle,
    effects,
    setStage,
    setupSource
  } = args
  let { setup, terminalHandle } = args
  let worktree
  if (createsWorktree) {
    db.recordRemoteAttachmentStage({
      dispatchId: params.dispatchId,
      stage: 'worktree_creating'
    })
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
      createdWithAgent: agent as TuiAgent,
      startupAgent: agent as TuiAgent,
      startupTerminalTitle: leaseTitle,
      ...(launch.preferences ? { startupLaunchPreferences: launch.preferences } : {}),
      activate: false,
      orchestrationManagedLaunch: true,
      lineage: { noParent: true }
    })
    worktree = created.worktree
    terminalHandle = created.startupTerminal?.handle
    effects.push({
      kind: 'worktree',
      action: 'created_top_level',
      id: created.worktree.id
    })
    setup = {
      requested: setupDecision,
      effective: setupDecision,
      source: setupSource,
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
    appendFederationTerminalEffects(
      effects,
      listed.terminals,
      terminalHandle,
      created.setupReceipt?.terminalHandle
    )
    appendFederationSetupEffect(effects, setup)
  } else {
    worktree = await runtime.showManagedTerminalWorkspace(params.worktree).catch(() => {
      throw new OrchestrationError(
        'worktree_not_found_on_server',
        `Worktree ${params.worktree} was not found on the selected worker server.`
      )
    })
    effects.push(
      { kind: 'worktree', action: 'reused', id: worktree.id },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
    if (terminalHandle) {
      const terminal = await runtime.showTerminal(terminalHandle)
      if (terminal.worktreeId !== worktree.id) {
        throw new OrchestrationError(
          'terminal_worktree_mismatch',
          `Terminal ${terminalHandle} does not belong to worktree ${worktree.id}.`
        )
      }
      if (!(await runtime.isTerminalRunningAgent(terminalHandle))) {
        throw new OrchestrationError(
          'agent_unconfigured',
          `Terminal ${terminalHandle} is not running a recognized agent.`
        )
      }
      effects.push({
        kind: 'terminal',
        role: 'agent',
        action: 'reused',
        id: terminalHandle
      })
    } else {
      setStage('terminal_create')
      const terminal = await runtime.createTerminal(`id:${worktree.id}`, {
        // Why: agent ids are not shell commands (`cursor` is the desktop app,
        // its CLI is `cursor-agent`); resolve through the TUI agent config.
        startupAgent: agent as TuiAgent,
        ...(launch.preferences ? { launchPreferences: launch.preferences } : {}),
        title: leaseTitle,
        presentation: 'background',
        orchestrationManagedLaunch: true
      })
      terminalHandle = terminal.handle
      effects.push({
        kind: 'terminal',
        role: 'agent',
        action: 'created',
        id: terminal.handle
      })
    }
  }
  return { worktree, terminalHandle, setup }
}
