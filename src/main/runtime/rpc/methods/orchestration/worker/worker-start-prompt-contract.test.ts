import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../../../../shared/agent-prompt-injection'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import {
  AGENT_PROMPT_TEST_WORKTREE_ID,
  createAgentPromptSubmissionRuntime
} from '../../../../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'

vi.mock('../../../../../git/worktree', () => ({
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
  runtime: Awaited<ReturnType<typeof createAgentPromptSubmissionRuntime>>['runtime']
  handle: string
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
}

async function createPromptContractHarness(
  outcome: 'accepted' | 'swallowed'
): Promise<PromptContractHarness> {
  let composerReady = false
  let submittedTurns = 0
  let startedTurns = 0
  let prematureSubmits = 0
  const fixture = await createAgentPromptSubmissionRuntime((runtime, data) => {
    if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
      setTimeout(() => runtime.onPtyData('pty-prompt', 'partial composer frame', Date.now()), 650)
      setTimeout(() => runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now()), 750)
      setTimeout(() => {
        composerReady = true
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
  }, 'codex')
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
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: { id: AGENT_PROMPT_TEST_WORKTREE_ID, repoId: 'repo-1' },
    startupTerminal: { spawned: true, handle },
    setupReceipt: {
      requested: 'run',
      hookFound: false,
      startupPolicy: 'start-immediately',
      state: 'not_configured'
    }
  } as never)
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')

  return {
    runtime,
    handle,
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
        agent: 'codex'
      }
    },
    requestId: `${REQUEST_ID}_${outcome}`,
    taskId: task.id,
    submittedTurns: () => submittedTurns,
    startedTurns: () => startedTurns,
    prematureSubmits: () => prematureSubmits,
    writes: fixture.writes
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

  it.each([
    ['succeeded', false],
    ['succeeded', true],
    ['failed', false],
    ['failed', true]
  ] as const)('preserves an early %s report with turn evidence=%s', async (outcome, observed) => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    vi.spyOn(harness.runtime, 'observeTerminalAgentPrompt').mockImplementation(
      async (_handle, prompt) => {
        const dispatch = harness.db.findActiveDispatchForAssignee(harness.handle)
        expect(dispatch).toBeDefined()
        expect(
          harness.db.settleWorkerReport({
            taskId: harness.taskId,
            dispatchId: dispatch!.id,
            outcome,
            result: 'Finished before the hook arrived'
          })
        ).toMatchObject({ action: 'settled', outcome })
        return observed ? { ...prompt, stages: ['input_accepted', 'turn_started'] } : prompt
      }
    )
    const pending = harness.dispatcher.dispatch(harness.request)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({
      ok: true,
      result: { state: 'ready', stage: 'settled', workerOutcome: outcome }
    })
    expect(harness.db.getTask(harness.taskId)?.status).toBe(
      outcome === 'succeeded' ? 'completed' : 'failed'
    )
  })

  it('retains accepted authority when the observation binding becomes stale', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    vi.spyOn(harness.runtime, 'observeTerminalAgentPrompt').mockRejectedValue(
      new Error('terminal_handle_stale')
    )
    const pending = harness.dispatcher.dispatch(harness.request)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(harness.db.findActiveDispatchForAssignee(harness.handle)).toMatchObject({
      status: 'pending',
      capability_hash: expect.any(String),
      capability_revoked_at: null
    })
    expect(harness.submittedTurns()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a worker question answerable after turn observation times out', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    let questionId = ''
    vi.spyOn(harness.runtime, 'observeTerminalAgentPrompt').mockImplementation(
      async (_handle, prompt) => {
        const dispatch = harness.db.findActiveDispatchForAssignee(harness.handle)!
        questionId = harness.db.createQuestion({
          runId: dispatch.run_id!,
          dispatchId: dispatch.id,
          askerHandle: harness.handle,
          question: 'Which target should I use?'
        }).question.message_id
        return prompt
      }
    )
    const pending = harness.dispatcher.dispatch(harness.request)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(harness.db.getQuestion(questionId)?.status).toBe('pending')
  })

  it('reports a swallowed Enter as start_unknown while keeping the worker and its capability', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    const pending = harness.dispatcher.dispatch(harness.request)

    await vi.runAllTimersAsync()
    const response = await pending
    // Codex supports turn-start observation and no turn started, so ready would be a lie: the
    // paste can sit unsent in the composer while the receipt looks like a healthy dispatch.
    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'outcome_unknown',
        stage: 'turn_start_unobserved',
        turnStart: 'unobserved',
        prompt: {
          requestId: harness.requestId,
          stages: ['input_accepted']
        },
        nextCommands: expect.arrayContaining([expect.stringContaining('worker-show')]),
        mutation: { requestId: harness.requestId, replayed: false }
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const dispatchId = (response.result as { dispatchId: string }).dispatchId
    await vi.advanceTimersByTimeAsync(20_000)
    // Unverifiable is not failure: exactly one submit, no blind retry, nothing torn down.
    expect(harness.submittedTurns()).toBe(1)
    expect(harness.startedTurns()).toBe(0)
    expect(harness.prematureSubmits()).toBe(0)
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(1)
    const persisted = reopenPromptContractDb(harness)
    expect(persisted.getTask(harness.taskId)?.status).toBe('blocked')
    expect(persisted.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'pending',
      last_failure: null,
      // The capability survives so a worker that recovers can still report; worker-report
      // settlement reconnects a start_unknown worker through 'ready'.
      capability_hash: expect.any(String),
      capability_revoked_at: null
    })
    expect(persisted.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'start_unknown',
      stage: 'turn_start_unobserved',
      last_error: expect.stringContaining('turn start could not be verified')
    })
    const persistedEffects = JSON.parse(
      persisted.getWorkerDispatch(dispatchId)?.effects ?? '[]'
    ) as { kind?: string; state?: string }[]
    expect(persistedEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' }),
        expect.objectContaining({ kind: 'dispatch_input', state: 'turn_unobserved' })
      ])
    )
    const callerFingerprint = persisted.getOrCreateLocalMutationCallerFingerprint()
    const receipt = persisted.getMutationReceipt(callerFingerprint, harness.requestId)
    expect(receipt).toMatchObject({ state: 'completed' })
    expect(JSON.parse(receipt?.receipt ?? 'null')).toMatchObject({
      dispatchId,
      state: 'outcome_unknown',
      stage: 'turn_start_unobserved',
      prompt: {
        requestId: harness.requestId,
        stages: ['input_accepted']
      }
    })
  })

  it('does not attribute output from the old busy turn to a queued prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, 'codex')
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    const pending = runtime.sendTerminalAgentPrompt(handle, 'queued prompt', {
      acceptQueued: true,
      requestId: 'busy-swallowed',
      observationTimeoutMs: 0
    })

    await vi.runAllTimersAsync()
    const send = await pending
    expect(send).toMatchObject({
      prompt: {
        requestId: 'busy-swallowed',
        stages: ['input_accepted']
      }
    })
    const observed = runtime.observeTerminalAgentPrompt(handle, send.prompt!, 1_000)
    setTimeout(() => {
      runtime.onPtyData('pty-prompt', 'old turn output', Date.now())
    }, 50)
    await vi.runAllTimersAsync()

    await expect(observed).resolves.toMatchObject({
      stages: ['input_accepted']
    })
  })

  it('refuses an 8 MiB inline spec before Task, Dispatch, or terminal effects', async () => {
    const harness = await createPromptContractHarness('accepted')
    const tasksBefore = harness.db.listTasks().map((task) => task.id)
    const params = harness.request.params as Record<string, unknown>
    delete params.task
    params.spec = 'x'.repeat(8 * 1024 * 1024)

    const response = await harness.dispatcher.dispatch(harness.request)

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'worker_prompt_too_large',
        data: { effectsApplied: false, maxTaskSpecBytes: expect.any(Number) }
      }
    })
    expect(harness.db.listTasks().map((task) => task.id)).toEqual(tasksBefore)
    expect(harness.db.getDispatchContext(harness.taskId)).toBeUndefined()
    expect(harness.writes).toEqual([])
  })
})
