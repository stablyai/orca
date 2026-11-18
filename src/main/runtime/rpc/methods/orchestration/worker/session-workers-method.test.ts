import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from './testing/worker-release.test-support'
import type { AgentStatusIpcPayload } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { structuredAgentSessionStatusPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import {
  sessionWorkerActivity,
  sessionWorkerState,
  workerResultSummary
} from './session-workers-method'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

const CHAT = 'chat-session-1'

function createdByChat(dispatchId: string): void {
  h.db.db
    .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = ? WHERE id = ?')
    .run(CHAT, dispatchId)
}

async function sessionWorkers(session = CHAT): Promise<OrchestrationSessionWorker[]> {
  const result = await h.call('orchestration.sessionWorkers', { session })
  return isSessionWorkersResult(result) ? result.workers : []
}

function isSessionWorkersResult(
  value: unknown
): value is { workers: OrchestrationSessionWorker[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'workers' in value &&
    Array.isArray(value.workers)
  )
}

describe('orchestration.sessionWorkers', () => {
  it('lists only the workers the chat created, named by their Task', async () => {
    const mine = await h.startWorker()
    const other = h.db.createTask({ spec: 'not from this chat', runId: h.activeRunId })
    createRootDispatch(h.db, other.id, 'term_other_worker')
    createdByChat(mine.dispatchId)

    const workers = await sessionWorkers()
    expect(workers).toHaveLength(1)
    expect(workers[0]).toMatchObject({
      dispatchId: mine.dispatchId,
      taskId: mine.taskId,
      // The harness publishes no agent status, so the host cannot confirm it runs.
      state: 'unverifiable',
      liveness: 'unverifiable',
      settledAt: null,
      host: 'local'
    })
    expect(workers[0]!.title.length).toBeGreaterThan(0)
    expect(workers[0]!.startedAt).toBeGreaterThan(0)
    expect(await sessionWorkers('another-chat')).toEqual([])
  })

  it('reports a finished worker as completed with when it settled', async () => {
    const { taskId, dispatchId } = await h.startWorker()
    createdByChat(dispatchId)
    h.settle(taskId, dispatchId, 'succeeded')

    const [worker] = await sessionWorkers()
    expect(worker).toMatchObject({ dispatchId, state: 'completed' })
    expect(worker!.settledAt).toBeGreaterThanOrEqual(worker!.startedAt)
  })

  it('flags a worker whose question waits on its coordinator', async () => {
    const { dispatchId } = await h.startWorker()
    createdByChat(dispatchId)
    expect((await sessionWorkers())[0]).toMatchObject({ dispatchId, pendingQuestion: false })

    h.db.createQuestion({
      runId: h.activeRunId,
      dispatchId,
      askerHandle: `dispatch:${dispatchId}`,
      question: 'Which branch?'
    })
    expect((await sessionWorkers())[0]).toMatchObject({ dispatchId, pendingQuestion: true })
  })
})

describe('a worker on a paired server', () => {
  function startedOnServer(dispatchId: string): void {
    h.db.db
      .prepare(
        `INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version, remote_terminal_handle)
         VALUES (?, 'env-win', 'windows 2', 'peer-win', 3, 'term_remote')`
      )
      .run(dispatchId)
    vi.spyOn(h.runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue({
      environmentId: 'env-win',
      name: 'windows 2',
      peerFingerprint: 'peer-win',
      pairingRevision: 1
    })
  }

  it("reads as live on that server while it waits on its coordinator's answer", async () => {
    const { dispatchId } = await h.startWorker()
    createdByChat(dispatchId)
    startedOnServer(dispatchId)
    vi.spyOn(h.runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeEpoch: 'epoch-win',
      items: [{ dispatchId, observation: { status: 'live', exactWorker: true } }]
    })
    h.db.createQuestion({
      runId: h.activeRunId,
      dispatchId,
      askerHandle: `dispatch:${dispatchId}`,
      question: 'Async hooks, or a version gate?'
    })

    const [worker] = await sessionWorkers()
    expect(worker).toMatchObject({
      dispatchId,
      state: 'working',
      liveness: 'live',
      host: 'remote',
      hostEnvironmentId: 'env-win',
      pendingQuestion: true
    })
  })

  it('tells its readers when the server stops answering, with no row written', async () => {
    const { dispatchId } = await h.startWorker()
    createdByChat(dispatchId)
    startedOnServer(dispatchId)
    const server = vi.spyOn(h.runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeEpoch: 'epoch-win',
      items: [{ dispatchId, observation: { status: 'live', exactWorker: true } }]
    })
    expect((await sessionWorkers())[0]).toMatchObject({ state: 'working' })

    const changed = vi.fn()
    h.db.federatedWorkersListener = changed
    server.mockRejectedValue(new Error('offline'))
    const later = Date.now() + 11_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    // The stale answer still draws while the server is asked again.
    expect((await sessionWorkers())[0]).toMatchObject({ state: 'working' })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith([dispatchId]))
    expect((await sessionWorkers())[0]).toMatchObject({ state: 'unverifiable', host: 'remote' })
  })

  it('reads as out of contact, never exited, when the server does not answer', async () => {
    const { dispatchId } = await h.startWorker()
    createdByChat(dispatchId)
    startedOnServer(dispatchId)
    vi.spyOn(h.runtime, 'callOrchestrationWorkerServer').mockRejectedValue(new Error('offline'))

    expect((await sessionWorkers())[0]).toMatchObject({
      dispatchId,
      state: 'unverifiable',
      host: 'remote',
      hostEnvironmentId: 'env-win'
    })
  })
})

describe('sessionWorkerActivity', () => {
  const live = { verdict: 'live', observedAt: 1, source: 'agent_status' } as const
  const chatRows = (state: AgentStatusIpcPayload['state']) =>
    new Map([[structuredAgentSessionStatusPaneKey('codex-chat'), { state }]])
  const stage = (activity: 'working' | 'done' | 'unknown') => ({
    worker: 'running',
    dispatch: 'dispatched',
    detail: null,
    activity
  })

  it("reads a terminal worker's own state and a chat worker's chat row", () => {
    // A Claude terminal worker mid-turn, and a Codex chat worker whose turn ended waiting on its coordinator.
    expect(
      sessionWorkerActivity({ stage: stage('working'), liveness: live }, null, new Map())
    ).toBe('working')
    expect(
      sessionWorkerActivity(
        { stage: stage('unknown'), liveness: live },
        'codex-chat',
        chatRows('done')
      )
    ).toBe('done')
  })

  it('reports nothing for a worker it cannot see live', () => {
    expect(
      sessionWorkerActivity(
        { stage: stage('unknown'), liveness: { verdict: 'unverifiable', reason: 'stale_status' } },
        'codex-chat',
        chatRows('working')
      )
    ).toBe('unknown')
  })
})

describe('sessionWorkerState', () => {
  const live = { verdict: 'live', observedAt: 1, source: 'agent_status' } as const
  it('trusts a recorded stop over any outcome', () => {
    expect(
      sessionWorkerState({ outcome: 'succeeded', liveness: live }, { workerState: 'stopped' })
    ).toBe('stopped')
  })
  it('reads lost contact as unverifiable, never as an exit', () => {
    expect(
      sessionWorkerState(
        {
          outcome: 'in_progress',
          liveness: { verdict: 'unverifiable', reason: 'host_unavailable' }
        },
        { workerState: 'ready' }
      )
    ).toBe('unverifiable')
  })
  it('calls a proven exit without a report stopped', () => {
    expect(
      sessionWorkerState(
        { outcome: 'in_progress', liveness: { verdict: 'exited', source: 'execution_host' } },
        { workerState: 'ready' }
      )
    ).toBe('stopped')
  })
  it('maps reported outcomes', () => {
    expect(
      sessionWorkerState({ outcome: 'failed', liveness: live }, { workerState: 'failed' })
    ).toBe('failed')
    expect(
      sessionWorkerState({ outcome: 'in_progress', liveness: live }, { workerState: 'ready' })
    ).toBe('working')
  })
})

describe('workerResultSummary', () => {
  it('reads the summary out of a worker report', () => {
    const report = JSON.stringify({
      provenance: 'worker_report',
      subject: 'README added',
      body: 'Added README.md saying hello.'
    })
    expect(workerResultSummary(report)).toBe('Added README.md saying hello.')
    expect(workerResultSummary(JSON.stringify({ subject: 'README added', body: '' }))).toBe(
      'README added'
    )
  })

  it('keeps a plain-text result as it is', () => {
    expect(workerResultSummary('  Shipped it  ')).toBe('Shipped it')
    expect(workerResultSummary('{}')).toBeNull()
  })
})
