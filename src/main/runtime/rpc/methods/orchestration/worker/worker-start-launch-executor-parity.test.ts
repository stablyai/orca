/**
 * A fresh worker starts through the shared launch executor, and its durable dispatch records must
 * read exactly as they did when the placement sequenced the launch itself: the same effects, the
 * same stage rows in the same order, one host question, and a refused chat that fails the start.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downgradeAgentLaunchModeForHost,
  type AgentLaunchModeReceipt
} from '../../../../../agent-launch/agent-launch-mode'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { WORKER_START_VOCABULARY } from '../../orchestration-worker-start-mode'
import { structuredWorkerIdentities } from '../../../../structured-worker-identity'
import type { WorkerEffect } from './worker-topology'
import { WorkerStartParams } from './worker-start-schema'

const sessionCreate = vi.hoisted((): { refusal: { code: string } | null } => ({ refusal: null }))

vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) =>
    sessionCreate.refusal
      ? { ok: false, refusal: { code: sessionCreate.refusal.code, message: 'refused here' } }
      : { ok: true, value: { sessionId: args.envelope.sessionId, fence: 7 } }
}))

const { placeWorkerAgent } = await import('./worker-start-agent-placement')

const STRUCTURED: AgentLaunchModeReceipt = {
  mode: 'structured',
  preferred: 'structured',
  reason: 'user_default',
  detail:
    'Started a structured chat session worker, the default for new agent tabs in your settings.'
}
const TERMINAL: AgentLaunchModeReceipt = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: 'Started a terminal agent worker, the default for new agent tabs in your settings.'
}
const COORDINATOR = { id: 'wt_coord', repoId: 'repo_1' }
const EXISTING = { id: 'wt_existing', repoId: 'repo_1' }

function fakes() {
  const stages: string[] = []
  const runtime = {
    createManagedWorktree: vi.fn(async (args: { startupAgent?: string }) => ({
      worktree: { id: 'wt_new', repoId: 'repo_1' },
      ...(args.startupAgent ? { startupTerminal: { handle: 'term_startup' } } : {})
    })),
    listTerminals: vi.fn(async (_selector: string) => ({
      terminals: [{ handle: 'term_startup', title: 'claude', tabId: 'tab_1', leafId: 'leaf_1' }]
    })),
    createTerminal: vi.fn(async () => ({ handle: 'term_worker', surface: 'background' })),
    getStructuredAgentSessionCreateSupport: vi.fn(
      async (): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> => ({
        supported: true
      })
    ),
    getClientSettings: vi.fn(() => ({})),
    ensureStructuredAgentSessionHost: async () => {}
  }
  const db = {
    recordWorkerStage: vi.fn((row: { stage: string }) => {
      stages.push(row.stage)
    })
  }
  const failedStages: string[] = []
  const effects: WorkerEffect[] = []
  return { runtime, db, stages, failedStages, effects }
}

function place(
  f: ReturnType<typeof fakes>,
  args: { mode: AgentLaunchModeReceipt; existing?: boolean; terminal?: string }
) {
  return placeWorkerAgent({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement calls only the methods faked here.
    runtime: f.runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement records only worker stages.
    db: f.db as unknown as OrchestrationDb,
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    params: WorkerStartParams.parse({
      from: 'term_coord',
      task: 'task_1',
      ...(args.existing ? {} : { name: 'child' }),
      ...(args.terminal ? { terminal: args.terminal } : {})
    }),
    requestedWorktree: args.existing ? 'id:wt_existing' : 'new-child',
    creationWorktree: args.existing ? undefined : COORDINATOR,
    resolvedWorktree: args.existing ? EXISTING : undefined,
    mode: args.mode,
    agent: args.terminal ? undefined : 'claude',
    launchPreferences: undefined,
    effects: f.effects,
    onStage: (stage) => f.failedStages.push(stage)
  })
}

function installHost() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a worker create reads only `subscribe` and the record's location.
  setStructuredAgentSessionHost({
    subscribe: () => () => {},
    deps: {
      store: { getRecord: () => ({ location: { executionHostId: 'local', wslDistro: null } }) }
    }
  } as never)
}

beforeEach(() => {
  sessionCreate.refusal = null
  structuredWorkerIdentities.clear()
  installHost()
})

describe('a fresh worker through the launch executor', () => {
  it('fails a refused structured worker in an existing worktree instead of starting a terminal', async () => {
    const f = fakes()
    sessionCreate.refusal = { code: 'structured_agent_session_unsupported' }

    await expect(place(f, { mode: STRUCTURED, existing: true })).rejects.toMatchObject({
      code: 'agent_unconfigured'
    })
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.stages).toEqual(['terminal_creating'])
  })

  it('fails a refused structured worker in the worktree it created, with no terminal', async () => {
    const f = fakes()
    sessionCreate.refusal = { code: 'structured_agent_session_unsupported' }

    await expect(place(f, { mode: STRUCTURED })).rejects.toMatchObject({
      code: 'agent_unconfigured'
    })
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.failedStages).toEqual(['worktree_create', 'terminal_create', 'terminal_create'])
  })

  it('does not ask the host again about an existing worktree whose mode it already settled', async () => {
    const f = fakes()

    const placed = await place(f, { mode: STRUCTURED, existing: true })

    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(f.runtime.getClientSettings).not.toHaveBeenCalled()
    expect(placed.mode).toBe(STRUCTURED)
    expect(placed.structuredSession?.identity.handle).toBe(placed.terminalHandle)
    expect(f.stages).toEqual(['terminal_creating'])
    expect(f.effects).toEqual([
      {
        kind: 'terminal',
        role: 'agent',
        action: 'created',
        id: placed.terminalHandle,
        surface: 'background'
      }
    ])
  })

  it('creates a structured worker’s worktree with no agent, asks the host once, then records the surface stage', async () => {
    const f = fakes()

    const placed = await place(f, { mode: STRUCTURED })

    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ startupAgent: expect.anything() })
    )
    expect(f.runtime.getStructuredAgentSessionCreateSupport).toHaveBeenCalledTimes(1)
    expect(f.runtime.getStructuredAgentSessionCreateSupport).toHaveBeenCalledWith(
      'id:wt_new',
      'claude'
    )
    expect(f.stages).toEqual(['worktree_creating', 'worktree_created', 'terminal_creating'])
    expect(f.failedStages).toEqual(['worktree_create', 'terminal_create', 'terminal_create'])
    expect(placed.worktree.id).toBe('wt_new')
    expect(placed.structuredSession).not.toBeNull()
  })

  it('starts a worker-<task> terminal in the worktree it created when the host refuses a chat', async () => {
    const f = fakes()
    f.runtime.getStructuredAgentSessionCreateSupport.mockResolvedValue({
      supported: false,
      reason: 'agent'
    })

    const placed = await place(f, { mode: STRUCTURED })

    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ startupAgent: expect.anything() })
    )
    expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:wt_new', {
      startupAgent: 'claude',
      launchSource: 'orchestration',
      title: 'worker-task_1',
      surfaceOwner: false
    })
    expect(f.stages).toEqual(['worktree_creating', 'worktree_created', 'terminal_creating'])
    expect(f.failedStages).toEqual(['worktree_create', 'terminal_create', 'terminal_create'])
    expect(placed.mode).toEqual(
      downgradeAgentLaunchModeForHost(
        STRUCTURED,
        { supported: false, reason: 'agent' },
        WORKER_START_VOCABULARY
      )
    )
    expect(placed.mode.reason).toBe('structured_unsupported_on_host')
    expect(placed).toMatchObject({ terminalHandle: 'term_worker', structuredSession: null })
    expect(f.effects.at(-1)).toEqual({
      kind: 'terminal',
      role: 'agent',
      action: 'created',
      id: 'term_worker',
      surface: 'background',
      warning: undefined
    })
  })

  it('creates a terminal worker’s worktree agent-first: no host question and no surface stage', async () => {
    const f = fakes()

    const placed = await place(f, { mode: TERMINAL })

    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startupAgent: 'claude', startupLaunchSource: 'orchestration' })
    )
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.stages).toEqual(['worktree_creating', 'worktree_created'])
    expect(f.failedStages).toEqual(['worktree_create'])
    expect(placed).toMatchObject({
      mode: TERMINAL,
      worktree: { id: 'wt_new' },
      terminalHandle: 'term_startup',
      structuredSession: null,
      setupReceipt: {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    })
    expect(placed).not.toHaveProperty('warning')
  })

  it('opens an existing worktree’s terminal worker as worker-<task>, leaving the sidebar alone', async () => {
    const f = fakes()

    const placed = await place(f, { mode: TERMINAL, existing: true })

    expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:wt_existing', {
      startupAgent: 'claude',
      launchSource: 'orchestration',
      title: 'worker-task_1',
      surfaceOwner: false
    })
    expect(f.stages).toEqual(['terminal_creating'])
    expect(placed).toMatchObject({ terminalHandle: 'term_worker', structuredSession: null })
  })

  it('reuses --terminal without a launch', async () => {
    const f = fakes()

    const placed = await place(f, { mode: TERMINAL, existing: true, terminal: 'term_running' })

    expect(placed.terminalHandle).toBe('term_running')
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(f.stages).toEqual([])
  })
})
