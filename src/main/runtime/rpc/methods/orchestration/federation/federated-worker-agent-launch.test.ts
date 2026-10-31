import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import { launchFederatedWorkerAgent } from './federated-worker-agent-launch'
import type { FederationEffect } from './federation-effects'
import { FederationAttachStartParams } from './federation-start-schema'

function fakes(created: { startupTerminal?: { handle: string } } = {}) {
  const terminalCreation: RuntimeTerminalCreate = {
    handle: created.startupTerminal?.handle ?? 'term_worker',
    ptyId: 'pty-worker',
    incarnationId: 'inc-worker',
    isReattach: true,
    agentSessionDisposition: 'adopted',
    worktreeId: 'repo::remote-wt',
    title: null
  }
  const stages: string[] = []
  const runtime = {
    createManagedWorktree: vi.fn(
      async (args: { onStartupTerminalCreated?: (terminal: RuntimeTerminalCreate) => void }) => {
        if (created.startupTerminal) {
          args.onStartupTerminalCreated?.(terminalCreation)
        }
        return {
          worktree: { id: 'repo::remote-wt', repoId: 'repo' },
          setupReceipt: {
            hookFound: true,
            startupPolicy: 'wait-for-setup',
            state: 'running',
            terminalHandle: 'term_setup'
          },
          ...created
        }
      }
    ),
    listTerminals: vi.fn(async () => ({
      terminals: [
        { handle: 'term_setup', title: 'setup', tabId: 'tab_s', leafId: 'leaf_s' },
        { handle: 'term_agent', title: 'claude', tabId: 'tab_a', leafId: 'leaf_a' }
      ]
    })),
    createTerminal: vi.fn(async () => terminalCreation),
    // Chat default on: federation still starts a terminal and never asks about a session.
    getClientSettings: vi.fn(() => ({ nativeChatProviders: EVERY_AGENT_CHAT })),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true }))
  }
  const db = {
    recordRemoteAttachmentStage: vi.fn((row: { stage: string }) => {
      stages.push(row.stage)
    })
  }
  return { runtime, db, stages, terminalCreation }
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
})
