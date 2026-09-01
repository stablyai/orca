import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { TERMINAL_METHODS } from './rpc/methods/terminal'

const WORKTREE_ID = 'repo-structured-chat::/tmp/structured-chat'
const SESSION_ID = 'session-structured-chat'
const COORDINATOR = {
  handle: 'term_structured_coord',
  tabId: '11111111-1111-4111-8111-111111111111',
  leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ptyId: 'pty-structured-coord'
}
const WORKER = {
  handle: 'term_structured_worker',
  tabId: '22222222-2222-4222-8222-222222222222',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'pty-structured-worker'
}
const PLAIN = {
  handle: 'term-plain',
  tabId: '33333333-3333-4333-8333-333333333333',
  leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ptyId: 'pty-plain'
}
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: WORKTREE_ID,
  workspaceKind: 'git-worktree'
}

type TestTerminal = typeof COORDINATOR

function paneKey(terminal: TestTerminal): string {
  return `${terminal.tabId}:${terminal.leafId}`
}

function makeStore() {
  const session = getDefaultWorkspaceSession()
  const repo = {
    id: 'repo-structured-chat',
    path: '/tmp/structured-chat',
    displayName: 'structured-chat',
    badgeColor: '#000000',
    addedAt: 0
  }
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [repo]),
    getRepo: vi.fn(() => repo),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

describe('orchestration while Structured Chat owns an agent session', () => {
  let directory: string
  let recordStore: AgentSessionRecordStore
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let writes: Mock<(ptyId: string, data: string) => void>
  let operationSequence: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-orchestration-structured-chat-'))
    recordStore = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: WORKTREE_ID,
      repoId: 'repo-structured-chat'
    } as never)
    writes = vi.fn<(ptyId: string, data: string) => void>()
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'unused' })),
      write: (ptyId: string, data: string) => {
        agentSessionPtyWriteGate.assertAdmitted(ptyId)
        writes(ptyId, data)
        return true
      },
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'codex'),
      listProcesses: vi.fn(async () => []),
      hasPty: vi.fn(() => true)
    } as never)
    for (const terminal of [COORDINATOR, WORKER, PLAIN]) {
      runtime.registerPty(terminal.ptyId, WORKTREE_ID, null, {
        tabId: terminal.tabId,
        leafId: terminal.leafId,
        incarnationId: `${terminal.ptyId}-incarnation`,
        agentLaunchAuthority: { launchToken: `${terminal.ptyId}-launch`, launchAgent: 'codex' }
      })
      runtime.registerPreAllocatedHandleForPty(terminal.ptyId, terminal.handle)
    }
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [COORDINATOR, WORKER, PLAIN].map((terminal) => ({
        tabId: terminal.tabId,
        worktreeId: WORKTREE_ID,
        title: 'Codex',
        activeLeafId: terminal.leafId,
        layout: null
      })),
      leaves: [COORDINATOR, WORKER, PLAIN].map((terminal, index) => ({
        tabId: terminal.tabId,
        worktreeId: WORKTREE_ID,
        leafId: terminal.leafId,
        paneRuntimeId: index + 1,
        ptyId: terminal.ptyId,
        paneTitle: null,
        title: 'Codex'
      }))
    })
    await runtime.listTerminals()
    for (const terminal of [COORDINATOR, WORKER, PLAIN]) {
      runtime.onPtyData(terminal.ptyId, '\x1b]0;Codex working\x07', 1)
      runtime.onPtyData(terminal.ptyId, '\x1b]0;Codex done\x07', 2)
    }
    operationSequence = 0
    await establishOwner('native', 'spawn-native', null)
    agentSessionPtyWriteGate.attachRecordLookup((sessionId) => recordStore.getRecord(sessionId))
    agentSessionPtyWriteGate.bindPty(WORKER.ptyId, SESSION_ID)
    dispatcher = new RpcDispatcher({
      runtime,
      methods: [...ORCHESTRATION_METHODS, ...TERMINAL_METHODS]
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    agentSessionPtyWriteGate.detachRecordLookup()
    db.close()
    await rm(directory, { recursive: true, force: true })
  })

  function operation() {
    operationSequence += 1
    return {
      callerKey: 'structured-chat-test',
      operationId: `1800000000000-${operationSequence.toString(16).padStart(32, '0')}`,
      fingerprint: `structured-chat-${operationSequence}`
    }
  }

  async function establishOwner(
    runtimeKind: 'native' | 'tui',
    spawnToken: string,
    expectedFence: number | null
  ): Promise<void> {
    const now = 1_800_000_000_000 + operationSequence
    const reserved = await recordStore.reserveOwner({
      sessionId: SESSION_ID,
      location: LOCATION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
      runtimeKind,
      expectedFence,
      spawnToken,
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe:
        expectedFence === null
          ? { outcome: 'indeterminate', reason: 'new session' }
          : { outcome: 'pid-absent' },
      operation: operation(),
      now
    })
    const fence = reserved.record.lease.runtimeFence
    await recordStore.commitProcessIdentity({
      sessionId: SESSION_ID,
      fence,
      process: { hostId: 'local', pid: 4242 + fence, processStartTimeMs: now, spawnToken },
      now
    })
    await recordStore.proveOwner({
      sessionId: SESSION_ID,
      fence,
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex', threadId: 'thread-1' },
        origin: fence === 1 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: now
      },
      now
    })
  }

  function createRun(coordinator = COORDINATOR) {
    return db.createRun({
      objective: 'Structured Chat lease coverage',
      coordinatorHandle: coordinator.handle,
      coordinatorPaneKey: paneKey(coordinator)
    })
  }

  function queueRunMessage(runId: string) {
    return db.insertMessage({
      from: 'term_sender',
      to: `run:${runId}`,
      subject: 'Queued guidance',
      type: 'status',
      runId
    })
  }

  async function rpc(method: string, params: Record<string, unknown>, capability?: string) {
    return dispatcher.dispatch({
      id: `request-${method}-${Math.random()}`,
      authToken: 'test-token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `mutation-${method}-${Math.random()}`,
      orchestrationCapability: capability
    })
  }

  it('retains a Run mailbox pointer while Structured Chat refuses the PTY write', () => {
    const run = createRun(WORKER)
    const message = queueRunMessage(run.id)

    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)

    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
    expect(writes.mock.calls.filter(([ptyId]) => ptyId === WORKER.ptyId)).toHaveLength(0)
  })

  it('redrives the same retained pointer after the lease returns to TUI', async () => {
    vi.useFakeTimers()
    const run = createRun(WORKER)
    const message = queueRunMessage(run.id)
    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()

    await establishOwner('tui', 'spawn-tui', 1)
    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    await vi.advanceTimersByTimeAsync(500)

    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
    expect(writes).toHaveBeenCalledTimes(2)
    expect(writes.mock.calls[0]?.[1]).toContain('orca orchestration check')
    expect(writes.mock.calls[1]).toEqual([WORKER.ptyId, '\r'])
  })

  it('fails worker-start truthfully when its reused terminal is in Structured Chat', async () => {
    const run = createRun()
    const task = db.createTask({ spec: 'Run the queued work', runId: run.id })

    const response = await rpc('orchestration.workerStart', {
      task: task.id,
      worktree: 'current',
      terminal: WORKER.handle,
      from: COORDINATOR.handle
    })

    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.ok).toBe(true)
    expect(response.result).toMatchObject({
      state: 'failed',
      failedStage: 'dispatch_input',
      lastError: expect.stringMatching(/Structured Chat.*Switch it to Terminal/),
      agentSessionRefusal: { code: 'agent_session_conflict', ownerRuntimeKind: 'native' }
    })
    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(db.getDispatchContext(task.id)?.status).toBe('failed')
    expect(writes.mock.calls.filter(([ptyId]) => ptyId === WORKER.ptyId)).toHaveLength(0)
  })

  it('reports a real gate refusal with typed metadata and zero bytes written', async () => {
    const response = await rpc('terminal.send', {
      terminal: WORKER.handle,
      text: 'new prompt',
      enter: true,
      agentPrompt: true,
      client: { id: 'test-client', type: 'desktop' }
    })

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: WORKER.handle,
        accepted: false,
        bytesWritten: 0,
        agentSessionRefusal: expect.objectContaining({
          code: 'agent_session_conflict',
          ownerRuntimeKind: 'native'
        })
      }
    })
    expect(writes).not.toHaveBeenCalled()
  })

  it('settles worker_done while its pane remains in Structured Chat', async () => {
    const run = createRun()
    const task = db.createTask({ spec: 'Finish from Structured Chat', runId: run.id })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: WORKER.handle,
      assigneePaneKey: paneKey(WORKER),
      processIncarnation: runtime.getTerminalProcessIncarnation(WORKER.handle) ?? undefined,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: paneKey(WORKER),
      processIncarnation: runtime.getTerminalProcessIncarnation(WORKER.handle)!
    })

    const response = await rpc(
      'orchestration.send',
      {
        from: WORKER.handle,
        subject: 'Done',
        body: 'Implemented the task. Verified the result. Nothing remains.',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      },
      capability
    )

    expect(response.ok).toBe(true)
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(writes.mock.calls.filter(([ptyId]) => ptyId === WORKER.ptyId)).toHaveLength(0)
  })

  it('delivers normally to a never-adopted terminal', async () => {
    vi.useFakeTimers()
    const run = createRun(PLAIN)
    const message = queueRunMessage(run.id)

    expect(agentSessionPtyWriteGate.admit(PLAIN.ptyId)).toEqual({
      admitted: true,
      sessionId: null,
      runtimeFence: null
    })
    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    await vi.advanceTimersByTimeAsync(500)

    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
    expect(writes).toHaveBeenCalledTimes(2)
    expect(writes.mock.calls[1]).toEqual([PLAIN.ptyId, '\r'])
  })
})
