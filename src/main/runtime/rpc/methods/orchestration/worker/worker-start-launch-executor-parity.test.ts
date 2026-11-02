import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
/** Shared-executor starts must preserve durable effects/stage order, ask host support once and fail refused chats. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSetupRun, type SetupRun } from '../../../../setup/setup-run'
import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
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
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'

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
const CREATION_TARGET = { repoSelector: 'repo_1', parentWorktreeId: 'wt_coord' }
const EXISTING = { id: 'wt_existing', repoId: 'repo_1' }

function fakes(setupRun?: SetupRun) {
  const stages: string[] = []
  const creation: RuntimeTerminalCreate = {
    handle: 'term_startup',
    worktreeId: 'wt_new',
    title: null,
    ptyId: 'pty-startup',
    incarnationId: 'inc-startup',
    isReattach: true,
    agentSessionDisposition: 'adopted'
  }
  const runtime = {
    createManagedWorktree: vi.fn(
      async (args: {
        onSetupRun?: (run: SetupRun) => void
        startupAgent?: string
        onStartupTerminalCreated?: (terminal: RuntimeTerminalCreate) => void
      }) => {
        if (setupRun) {
          args.onSetupRun?.(setupRun)
        }
        if (args.startupAgent) {
          args.onStartupTerminalCreated?.(creation)
        }
        return {
          worktree: { id: 'wt_new', repoId: 'repo_1' },
          ...(setupRun
            ? {
                setupReceipt: {
                  hookFound: true,
                  startupPolicy: 'wait-for-setup',
                  state: 'running',
                  terminalHandle: 'term_setup'
                }
              }
            : {}),
          ...(args.startupAgent ? { startupTerminal: { handle: creation.handle } } : {})
        }
      }
    ),
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
  return { runtime, db, stages, failedStages, effects, creation }
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
    creationTarget: args.existing ? undefined : CREATION_TARGET,
    resolvedWorktree: args.existing ? EXISTING : undefined,
    mode: args.mode,
    agent: args.terminal ? undefined : 'claude',
    launchPreferences: undefined,
    effects: f.effects,
    onStage: (stage) => f.failedStages.push(stage)
  })
}

function installHost() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host supplies subscribe and a complete writable record for the newly minted id.
  setStructuredAgentSessionHost({
    subscribe: () => () => {},
    deps: {
      store: {
        requireWritableRecord: (sessionId: string) =>
          agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
      }
    }
  } as never)
}

beforeEach(() => {
  sessionCreate.refusal = null
  structuredWorkerIdentities.clear()
  installHost()
})

afterEach(() => vi.useRealTimers())

describe('a fresh worker through the launch executor', () => {
  it('holds structured creation until required Setup succeeds, sharing the readiness deadline', async () => {
    const run = createSetupRun(true)
    const f = fakes(run)
    const pending = place(f, { mode: STRUCTURED })
    await vi.waitFor(() => expect(f.failedStages.at(-1)).toBe('setup_wait'))
    expect(f.stages).toEqual(['worktree_creating', 'worktree_created'])
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    run.settle({ kind: 'succeeded' })
    const placed = await pending
    expect(placed.structuredSession).not.toBeNull()
    expect(placed.setupReceipt.state).toBe('succeeded')
    expect(placed.readinessDeadline).toBeGreaterThan(Date.now())
    expect(placed.readinessDeadline).toBeLessThanOrEqual(Date.now() + 60_000)
  })

  it('refuses a failed required Setup before a worker session or fallback exists', async () => {
    const run = createSetupRun(true)
    const f = fakes(run)
    const pending = place(f, { mode: STRUCTURED })
    const refused = expect(pending).rejects.toMatchObject({
      setup: { state: 'failed' },
      cause: { code: 'agent_launch_setup_not_completed' }
    })
    await vi.waitFor(() => expect(f.failedStages.at(-1)).toBe('setup_wait'))
    run.settle({ kind: 'failed', exitCode: 7 })
    await refused
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.stages).toEqual(['worktree_creating', 'worktree_created'])
    expect(structuredWorkerIdentities.list()).toEqual([])
  })

  it('ends the pending worker at its deadline while leaving the Setup run observable', async () => {
    vi.useFakeTimers()
    const run = createSetupRun(true)
    const f = fakes(run)
    const pending = place(f, { mode: STRUCTURED })
    const refused = expect(pending).rejects.toMatchObject({
      stage: 'setup_wait',
      setup: { state: 'running' },
      cause: { outcome: { kind: 'ended', reason: 'deadline' } }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.failedStages.at(-1)).toBe('setup_wait')
    await vi.advanceTimersByTimeAsync(60_000)
    await refused
    expect(structuredWorkerIdentities.list()).toEqual([])
    expect(run.result).toBeUndefined()
    run.settle({ kind: 'succeeded' })
  })

  it('reports a deadline after Setup succeeded as a readiness timeout with Setup succeeded', async () => {
    vi.useFakeTimers()
    const run = createSetupRun(true)
    const f = fakes(run)
    const support = Promise.withResolvers<{ supported: boolean }>()
    f.runtime.getStructuredAgentSessionCreateSupport.mockReturnValueOnce(support.promise)
    const failed = place(f, { mode: STRUCTURED }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(59_999)
    run.settle({ kind: 'succeeded' })
    await vi.advanceTimersByTimeAsync(2)
    support.resolve({ supported: true })
    expect(await failed).toMatchObject({
      stage: 'agent_readiness',
      message: 'Agent did not become ready (timeout).',
      setup: { state: 'succeeded' }
    })
    expect(f.effects.find((effect) => effect.kind === 'setup')?.state).toBe('succeeded')
  })

  it('leaves a terminal worker’s pending required Setup to its readiness wait', async () => {
    const run = createSetupRun(true)
    const placed = await place(fakes(run), { mode: TERMINAL })
    expect(placed.setupReceipt.state).toBe('running')
    run.settle({ kind: 'ended', reason: 'closed' })
  })

  it('fails a refused structured worker in an existing worktree instead of starting a terminal', async () => {
    const f = fakes()
    sessionCreate.refusal = { code: 'structured_agent_session_unsupported' }

    await expect(place(f, { mode: STRUCTURED, existing: true })).rejects.toMatchObject({
      code: 'agent_unconfigured'
    })
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.stages).toEqual(['terminal_creating'])
  })

  it('fails a refused structured worker in the worktree it created, leaving a shell', async () => {
    const f = fakes()
    sessionCreate.refusal = { code: 'structured_agent_session_unsupported' }

    await expect(place(f, { mode: STRUCTURED })).rejects.toMatchObject({
      code: 'agent_unconfigured'
    })
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:wt_new', { surfaceOwner: false })
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
      'claude',
      { requireInstalledChatProgram: true }
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
      suppressStartupUpdatePrompt: true,
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
    expect(placed.terminalCreation).toBe(f.creation)
  })

  it('opens an existing worktree’s terminal worker as worker-<task>, leaving the sidebar alone', async () => {
    const f = fakes()

    const placed = await place(f, { mode: TERMINAL, existing: true })

    expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:wt_existing', {
      startupAgent: 'claude',
      launchSource: 'orchestration',
      suppressStartupUpdatePrompt: true,
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
