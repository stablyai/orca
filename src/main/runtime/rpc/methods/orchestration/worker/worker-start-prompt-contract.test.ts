import type * as WorktreeScanCacheModule from '../../../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../../../git/worktrees/catalog/worktree-listing'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import {
  AGENT_PROMPT_TEST_WORKTREE_ID,
  createAgentPromptSubmissionRuntime
} from '../../../../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

vi.mock('../../../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
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
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

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
  outcome: 'accepted' | 'swallowed',
  agent: TuiAgent = 'codex'
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
  }, agent)
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
        agent
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

describe('orchestration worker-start prompt contract', () => {
  afterEach(() => {
    for (const db of openDatabases.splice(0)) {
      db.close()
    }
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not attribute output from the old busy turn to a queued prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, 'codex')
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    const pending = runtime.sendTerminalAgentPrompt(handle, 'queued prompt', {
      inputKind: 'driving',
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
