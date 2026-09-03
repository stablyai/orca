import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../../shared/agent-prompt-injection'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import {
  AGENT_PROMPT_TEST_WORKTREE_ID,
  createAgentPromptSubmissionRuntime
} from '../../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { TuiAgent } from '../../../../shared/tui-agent'

vi.mock('../../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-contract',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-contract',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REQUEST_ID = 'worker_start_prompt_contract'
const openDatabases: OrchestrationDb[] = []
const temporaryRoots: string[] = []

type PromptContractHarness = {
  db: OrchestrationDb
  dbPath: string
  dispatcher: RpcDispatcher
  request: RpcRequest
  requestId: string
  taskId: string
  submittedTurns: () => number
  startedTurns: () => number
  prematureSubmits: () => number
  writes: string[]
  runtime: Awaited<ReturnType<typeof createAgentPromptSubmissionRuntime>>['runtime']
  handle: string
}

async function createPromptContractHarness(
  outcome: 'accepted' | 'swallowed',
  launchAgent: TuiAgent = 'aider'
): Promise<PromptContractHarness> {
  let composerReady = false
  let submittedTurns = 0
  let startedTurns = 0
  let prematureSubmits = 0
  const fixture = await createAgentPromptSubmissionRuntime((runtime, data) => {
    if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
      composerReady = true
      setTimeout(() => runtime.onPtyData('pty-prompt', 'partial composer frame', Date.now()), 650)
      setTimeout(() => runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now()), 750)
      setTimeout(() => {
        runtime.onPtyData('pty-prompt', 'final composer frame', Date.now())
      }, 1_000)
      return
    }
    if (data !== '\r') {
      return
    }
    submittedTurns += 1
    if (!composerReady) {
      prematureSubmits += 1
    }
    if (outcome === 'accepted') {
      startedTurns += 1
      runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    }
  }, launchAgent)
  const { runtime, handle } = fixture
  runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'orca-worker-prompt-contract-'))
  temporaryRoots.push(temporaryRoot)
  const dbPath = join(temporaryRoot, 'orchestration.db')
  const db = new OrchestrationDb(dbPath)
  openDatabases.push(db)
  runtime.setOrchestrationDb(db)
  const run = db.createRun({
    objective: 'Worker prompt contract',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = db.createTask({ spec: 'start exactly one worker turn', runId: run.id })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((candidate) =>
    candidate === 'term_coord'
      ? COORDINATOR_PANE_KEY
      : candidate === handle
        ? WORKER_PANE_KEY
        : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((candidate) =>
    candidate === handle ? `runtime_test:${handle}:1` : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
    handle: 'term_coord',
    worktreeId: 'repo::parent',
    status: 'running'
  } as never)
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
    id: 'repo::parent',
    repoId: 'repo-1'
  } as never)
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo-1', kind: 'git' } as never)
  let launchTokenHash: string | null = null
  if (launchAgent === 'codex') {
    vi.spyOn(runtime, 'createPreAllocatedTerminalHandle').mockReturnValue(handle)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((candidate) =>
      candidate === handle && launchTokenHash
        ? ({
            runtimeId: runtime.getRuntimeId(),
            terminalHandle: handle,
            ptyId: 'pty-prompt',
            worktreeId: AGENT_PROMPT_TEST_WORKTREE_ID,
            paneKey: WORKER_PANE_KEY,
            processIncarnation: `runtime_test:${handle}:1`,
            launchTokenHash,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle,
      accepted: true,
      bytesWritten: 1
    } as never)
  }
  vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
    launchTokenHash = args.startupLaunchToken
      ? createHash('sha256').update(args.startupLaunchToken).digest('hex')
      : null
    return {
      worktree: { id: AGENT_PROMPT_TEST_WORKTREE_ID, repoId: 'repo-1' },
      startupTerminal: { spawned: true, handle },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as never
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'getWorktreeOrchestrationCliCommand').mockResolvedValue('orca')

  return {
    db,
    dbPath,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    request: {
      id: `rpc_${outcome}`,
      authToken: 'caller-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `${REQUEST_ID}_${outcome}`,
      method: 'orchestration.workerStart',
      params: {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: `prompt-contract-${outcome}`,
        agent: launchAgent
      }
    },
    requestId: `${REQUEST_ID}_${outcome}`,
    taskId: task.id,
    submittedTurns: () => submittedTurns,
    startedTurns: () => startedTurns,
    prematureSubmits: () => prematureSubmits,
    writes: fixture.writes,
    runtime,
    handle
  }
}

function reopenPromptContractDb(harness: PromptContractHarness): OrchestrationDb {
  const index = openDatabases.indexOf(harness.db)
  if (index !== -1) {
    openDatabases.splice(index, 1)
  }
  harness.db.close()
  harness.db = new OrchestrationDb(harness.dbPath)
  openDatabases.push(harness.db)
  return harness.db
}

describe('orchestration worker-start prompt contract', () => {
  afterEach(() => {
    for (const db of openDatabases.splice(0)) {
      db.close()
    }
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    vi.useRealTimers()
  })

  it('durably accepts exactly one submitted and started turn', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('accepted')
    const pending = harness.dispatcher.dispatch(harness.request)

    await vi.runAllTimersAsync()
    const response = await pending
    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'ready',
        stage: 'input_accepted',
        mutation: { requestId: harness.requestId, replayed: false },
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const dispatchId = (response.result as { dispatchId: string }).dispatchId
    expect(harness.submittedTurns()).toBe(1)
    expect(harness.startedTurns()).toBe(1)
    expect(harness.prematureSubmits()).toBe(0)
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(1)
    const persisted = reopenPromptContractDb(harness)
    expect(persisted.getTask(harness.taskId)?.status).toBe('dispatched')
    expect(persisted.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      capability_hash: expect.any(String),
      capability_revoked_at: null
    })
    expect(persisted.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted',
      last_error: null
    })
    const callerFingerprint = persisted.getOrCreateLocalMutationCallerFingerprint()
    const receipt = persisted.getMutationReceipt(callerFingerprint, harness.requestId)
    expect(receipt).toMatchObject({ state: 'completed' })
    expect(JSON.parse(receipt?.receipt ?? 'null')).toMatchObject({
      dispatchId,
      state: 'ready',
      stage: 'input_accepted'
    })
  })

  it('reports a swallowed Enter as stalled without sending a rescue Enter', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    const pending = harness.dispatcher.dispatch(harness.request)

    await vi.runAllTimersAsync()
    const response = await pending
    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        failedStage: 'dispatch_input',
        lastError: 'agent_prompt_stalled',
        mutation: { requestId: harness.requestId, replayed: false }
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const dispatchId = (response.result as { dispatchId: string }).dispatchId
    await vi.advanceTimersByTimeAsync(20_000)
    expect(harness.submittedTurns()).toBe(1)
    expect(harness.startedTurns()).toBe(0)
    expect(harness.prematureSubmits()).toBe(0)
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(1)
    const persisted = reopenPromptContractDb(harness)
    expect(persisted.getTask(harness.taskId)?.status).toBe('failed')
    // Why (#16095): the receipt still reports the failure, but Enter was written before it was
    // verified — so the capability survives and the worker's own report can correct the record.
    expect(persisted.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'agent_prompt_stalled',
      capability_revoked_at: null
    })
    expect(persisted.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'dispatch_input',
      last_error: 'agent_prompt_stalled'
    })
    const callerFingerprint = persisted.getOrCreateLocalMutationCallerFingerprint()
    const receipt = persisted.getMutationReceipt(callerFingerprint, harness.requestId)
    expect(receipt).toMatchObject({ state: 'completed' })
    expect(JSON.parse(receipt?.receipt ?? 'null')).toMatchObject({
      dispatchId,
      state: 'failed',
      failedStage: 'dispatch_input',
      lastError: 'agent_prompt_stalled'
    })
  })

  it('launches a Codex new-child worker with argv authority and no prompt submission', async () => {
    const harness = await createPromptContractHarness('accepted', 'codex')
    const waitForTerminal = vi.spyOn(harness.runtime, 'waitForTerminal').mockResolvedValue({
      handle: harness.handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })

    const response = await harness.dispatcher.dispatch(harness.request)

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'ready',
        stage: 'input_accepted',
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'terminal', role: 'agent', action: 'created' }),
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const dispatchId = (response.result as { dispatchId: string }).dispatchId
    const startup = vi.mocked(harness.runtime.createManagedWorktree).mock.calls[0]?.[0]
    const startupPrompt = await startup?.startupPromptFactory?.('repo::created')
    expect(startup).toMatchObject({
      startupAgent: 'codex',
      startupLaunchToken: expect.any(String),
      startupPreAllocatedHandle: harness.handle,
      lineage: { parentWorktree: 'repo::parent', noParent: false }
    })
    expect(startupPrompt).toMatch(/--dispatch-capability dcap_[A-Za-z0-9_-]+/)
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(waitForTerminal).toHaveBeenCalledTimes(1)
    expect(waitForTerminal).toHaveBeenCalledWith(harness.handle, {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(0)
    expect(harness.db.getDispatchContextById(dispatchId)).toMatchObject({
      launch_token_hash: createHash('sha256')
        .update(startup?.startupLaunchToken as string)
        .digest('hex'),
      assignee_pane_key: WORKER_PANE_KEY,
      process_incarnation: `runtime_test:${harness.handle}:1`
    })
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      terminal_handle: harness.handle,
      pane_key: WORKER_PANE_KEY,
      process_incarnation: `runtime_test:${harness.handle}:1`
    })
  })
})
