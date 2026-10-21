import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import { launchFederatedWorkerAgent } from './federated-worker-agent-launch'
import type { FederationEffect } from './federation-effects'
import { FederationAttachStartParams } from './federation-start-schema'

function fakes(created: { startupTerminal?: { handle: string } } = {}) {
  const stages: string[] = []
  const runtime = {
    createManagedWorktree: vi.fn(async () => ({
      worktree: { id: 'repo::remote-wt', repoId: 'repo' },
      setupReceipt: {
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalHandle: 'term_setup'
      },
      ...created
    })),
    listTerminals: vi.fn(async () => ({
      terminals: [
        { handle: 'term_setup', title: 'setup', tabId: 'tab_s', leafId: 'leaf_s' },
        { handle: 'term_agent', title: 'claude', tabId: 'tab_a', leafId: 'leaf_a' }
      ]
    })),
    createTerminal: vi.fn(async () => ({ handle: 'term_worker' })),
    // Chat default on: federation still starts a terminal and never asks about a session.
    getClientSettings: vi.fn(() => ({ experimentalNativeChat: true })),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true }))
  }
  const db = {
    recordRemoteAttachmentStage: vi.fn((row: { stage: string }) => {
      stages.push(row.stage)
    })
  }
  return { runtime, db, stages }
}

const PARAMS = FederationAttachStartParams.parse({
  runId: 'run_home',
  dispatchId: 'ctx_remote',
  taskId: 'task_remote',
  taskSpec: 'remote work',
  protocolVersion: 3,
  worktree: 'new-top-level',
  repo: 'repo',
  name: 'remote-wt',
  agent: 'claude'
})

function launch(f: ReturnType<typeof fakes>, worktree?: { id: string }) {
  const effects: FederationEffect[] = []
  const setups: WorkerSetupReceipt[] = []
  const stagesSeen: string[] = []
  const done = launchFederatedWorkerAgent({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch calls only the methods faked here.
    runtime: f.runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch records only attachment stages.
    db: f.db as unknown as OrchestrationDb,
    params: PARAMS,
    agent: 'claude',
    launchPreferences: { model: 'opus' },
    ...(worktree ? { worktree } : {}),
    setupSource: 'orchestration_default',
    effects,
    onSetup: (setup) => setups.push(setup),
    onStage: (stage) => stagesSeen.push(stage)
  })
  return { done, effects, setups, stagesSeen }
}

describe('a federated worker through the launch executor', () => {
  it('creates the new top-level worktree agent-first with the attachment’s own records', async () => {
    const f = fakes({ startupTerminal: { handle: 'term_agent' } })
    const run = launch(f)

    await expect(run.done).resolves.toEqual({
      worktree: { id: 'repo::remote-wt', repoId: 'repo' },
      terminalHandle: 'term_agent'
    })
    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith({
      repoSelector: 'repo',
      name: 'remote-wt',
      baseBranch: undefined,
      displayName: undefined,
      displayNameKind: undefined,
      comment: undefined,
      runHooks: false,
      setupDecision: 'run',
      awaitTerminalProvisioning: true,
      observeSetupCompletion: true,
      createdWithAgent: 'claude',
      startupAgent: 'claude',
      startupLaunchSource: 'orchestration',
      startupLaunchPreferences: { model: 'opus' },
      activate: false,
      lineage: { noParent: true }
    })
    expect(f.stages).toEqual(['worktree_creating'])
    expect(run.stagesSeen).toEqual(['worktree_create'])
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(run.effects).toEqual([
      { kind: 'worktree', action: 'created_top_level', id: 'repo::remote-wt' },
      {
        kind: 'terminal',
        role: 'setup',
        action: 'created',
        id: 'term_setup',
        tabId: 'tab_s',
        leafId: 'leaf_s'
      },
      {
        kind: 'terminal',
        role: 'agent',
        action: 'created',
        id: 'term_agent',
        tabId: 'tab_a',
        leafId: 'leaf_a'
      },
      {
        kind: 'setup',
        action: 'run',
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalId: 'term_setup'
      }
    ])
  })

  it('reports the created worktree’s setup before failing on a missing agent terminal', async () => {
    const f = fakes({})
    const run = launch(f)

    await expect(run.done).rejects.toThrow('Agent-first worktree creation returned no terminal.')
    expect(run.setups).toEqual([
      {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      }
    ])
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('opens a background worker-<task> terminal in an existing worktree', async () => {
    const f = fakes()
    const run = launch(f, { id: 'folder:remote' })

    await expect(run.done).resolves.toEqual({
      worktree: { id: 'folder:remote' },
      terminalHandle: 'term_worker'
    })
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:folder:remote', {
      startupAgent: 'claude',
      launchSource: 'orchestration',
      launchPreferences: { model: 'opus' },
      title: 'worker-task_remote',
      presentation: 'background'
    })
    expect(run.effects).toEqual([
      { kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }
    ])
    expect(f.runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(run.stagesSeen).toEqual(['terminal_create', 'terminal_create'])
  })
})
