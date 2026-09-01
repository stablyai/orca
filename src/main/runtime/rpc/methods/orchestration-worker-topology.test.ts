import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { workerCustomAgentLaunchRequest } from './orchestration-worker-agent-launch'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  type WorkerEffect
} from './orchestration-worker-topology'

const CUSTOM_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as const

describe('workerCustomAgentLaunchRequest', () => {
  it('routes a custom id through an identity-only host launch', () => {
    expect(workerCustomAgentLaunchRequest(CUSTOM_ID)).toEqual({
      selection: { kind: 'agent', agent: CUSTOM_ID },
      allowEmptyPromptLaunch: true
    })
  })

  it('keeps built-in ids on the legacy startupAgent path', () => {
    expect(workerCustomAgentLaunchRequest('codex')).toBeNull()
  })
})

describe('createExistingWorktreeWorkerTerminal', () => {
  it('launches a built-in agent via startupAgent', async () => {
    const createTerminal = vi.fn(async () => ({ handle: 'term-1', surface: 'background' }))
    const effects: WorkerEffect[] = []
    const result = await createExistingWorktreeWorkerTerminal({
      runtime: { createTerminal } as unknown as OrcaRuntimeService,
      worktreeId: 'wt-1',
      agent: 'codex',
      launchPreferences: { model: 'gpt-5.3-codex' },
      taskId: 'task-1',
      effects
    })

    expect(result.handle).toBe('term-1')
    expect(createTerminal).toHaveBeenCalledWith('id:wt-1', {
      startupAgent: 'codex',
      launchPreferences: { model: 'gpt-5.3-codex' },
      title: 'worker-task-1',
      surfaceOwner: false
    })
    expect(effects).toEqual([
      expect.objectContaining({ kind: 'terminal', role: 'agent', action: 'created', id: 'term-1' })
    ])
  })

  it('launches a custom agent through the host agentLaunch boundary', async () => {
    const createTerminal = vi.fn(async () => ({ handle: 'term-2', surface: 'background' }))
    const effects: WorkerEffect[] = []
    const result = await createExistingWorktreeWorkerTerminal({
      runtime: { createTerminal } as unknown as OrcaRuntimeService,
      worktreeId: 'wt-1',
      agent: CUSTOM_ID,
      taskId: 'task-1',
      effects
    })

    expect(result.handle).toBe('term-2')
    expect(createTerminal).toHaveBeenCalledWith('id:wt-1', {
      agentLaunch: {
        selection: { kind: 'agent', agent: CUSTOM_ID },
        allowEmptyPromptLaunch: true
      },
      title: 'worker-task-1',
      surfaceOwner: false
    })
  })

  it('surfaces a typed pre-spawn launch failure instead of returning no terminal', async () => {
    const createTerminal = vi.fn(async () => ({
      agentLaunch: { status: 'failed' as const, failure: { code: 'base_agent_unavailable' } }
    }))
    await expect(
      createExistingWorktreeWorkerTerminal({
        runtime: { createTerminal } as unknown as OrcaRuntimeService,
        worktreeId: 'wt-1',
        agent: CUSTOM_ID,
        taskId: 'task-1',
        effects: []
      })
    ).rejects.toThrow(/base_agent_unavailable/)
  })
})

describe('createWorkerWorktree', () => {
  function makeDeps(created: Record<string, unknown>) {
    const createManagedWorktree = vi.fn(async (_args: Record<string, unknown>) => created)
    const listTerminals = vi.fn(async () => ({ terminals: [] }))
    const runtime = { createManagedWorktree, listTerminals } as unknown as OrcaRuntimeService
    const db = { recordWorkerStage: vi.fn() } as unknown as OrchestrationDb
    return { runtime, db, createManagedWorktree }
  }

  const baseArgs = {
    dispatchId: 'dispatch-1',
    requestedWorktree: 'new-child',
    coordinatorWorktree: { id: 'wt-coord', repoId: 'repo-1' } as never,
    params: { name: 'worker-branch', from: 'term-coord' },
    effects: [] as WorkerEffect[]
  }

  it('creates a custom-agent worktree with a host agentLaunch instead of startupAgent', async () => {
    const { runtime, db, createManagedWorktree } = makeDeps({
      worktree: { id: 'wt-new' },
      startupTerminal: { spawned: true, handle: 'term-3', surface: 'background' }
    })

    const created = await createWorkerWorktree({
      ...baseArgs,
      runtime,
      db,
      agent: CUSTOM_ID,
      effects: []
    })

    expect(created.terminalHandle).toBe('term-3')
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        createdWithAgent: CUSTOM_ID,
        agentLaunch: {
          selection: { kind: 'agent', agent: CUSTOM_ID },
          allowEmptyPromptLaunch: true
        }
      })
    )
    expect(createManagedWorktree.mock.calls[0][0]).not.toHaveProperty('startupAgent')
  })

  it('keeps built-in agents on the legacy startupAgent worktree path', async () => {
    const { runtime, db, createManagedWorktree } = makeDeps({
      worktree: { id: 'wt-new' },
      startupTerminal: { spawned: true, handle: 'term-4', surface: 'background' }
    })

    await createWorkerWorktree({
      ...baseArgs,
      runtime,
      db,
      agent: 'codex',
      launchPreferences: { model: 'gpt-5.3-codex' },
      effects: []
    })

    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'codex',
        startupLaunchPreferences: { model: 'gpt-5.3-codex' }
      })
    )
    expect(createManagedWorktree.mock.calls[0][0]).not.toHaveProperty('agentLaunch')
  })

  it('names the launch failure when the custom-agent spawn produced no terminal', async () => {
    const { runtime, db } = makeDeps({
      worktree: { id: 'wt-new' },
      agentLaunchResult: { status: 'failed', failure: { code: 'agent_definition_not_found' } }
    })

    await expect(
      createWorkerWorktree({
        ...baseArgs,
        runtime,
        db,
        agent: CUSTOM_ID,
        effects: []
      })
    ).rejects.toThrow(/agent_definition_not_found/)
  })
})
