import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from './testing/worker-release.test-support'
import type { AgentStatusIpcPayload } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { structuredAgentSessionStatusPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { readConnectorWorkerActivity } from './connector-worker-activity'
import {
  readDispatchWorkers,
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

describe('connector conversations’ open workers', () => {
  function fromConnector(dispatchId: string, session: string): void {
    h.db.db
      .prepare(
        `UPDATE dispatch_contexts SET creator_orca_session_id = ?, creator_turn_source = 'connector'
          WHERE id = ?`
      )
      .run(session, dispatchId)
  }

  function rootDispatch(spec: string, handle: string): string {
    const task = h.db.createTask({ spec, runId: h.activeRunId })
    return createRootDispatch(h.db, task.id, handle).id
  }

  it('reads every chat in one pass, leaving out settled workers and other starts', async () => {
    const open = await h.startWorker()
    fromConnector(open.dispatchId, CHAT)
    const finished = rootDispatch('finished', 'term_finished')
    fromConnector(finished, CHAT)
    h.db.db.prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`).run(finished)
    createdByChat(rootDispatch('typed in Orca', 'term_typed'))
    const asking = rootDispatch('asks', 'term_asking')
    fromConnector(asking, 'chat-session-2')
    h.db.createQuestion({
      runId: h.activeRunId,
      dispatchId: asking,
      askerHandle: `dispatch:${asking}`,
      question: 'Which branch?'
    })

    const read = await readConnectorWorkerActivity(h.runtime, [
      CHAT,
      'chat-session-2',
      'chat-session-3'
    ])
    // The harness publishes no agent status, so the host cannot confirm either runs.
    expect(Object.fromEntries(read)).toEqual({
      [CHAT]: [{ state: 'unverifiable', activity: 'unknown', pendingQuestion: false }],
      'chat-session-2': [{ state: 'unverifiable', activity: 'unknown', pendingQuestion: true }],
      'chat-session-3': []
    })
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

describe('a terminal its host cannot find', () => {
  // The harness's worker publishes no status row, so its host reads it unverifiable / missing_status.
  async function goneWorker(): Promise<string> {
    const { dispatchId } = await h.startWorker()
    createdByChat(dispatchId)
    vi.spyOn(h.runtime, 'refreshAuthoritativeTerminalInventory').mockResolvedValue(() => true)
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(h.runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
    vi.spyOn(h.runtime, 'resolveTerminalIdentity').mockImplementation((handle) => ({
      handle,
      live: false
    }))
    return dispatchId
  }

  it('reads as stopped, the way a worker that exited without reporting does', async () => {
    const dispatchId = await goneWorker()
    expect((await sessionWorkers())[0]).toMatchObject({
      dispatchId,
      state: 'stopped',
      liveness: 'unverifiable',
      settledAt: null
    })
    // Shown only: the Dispatch stays open for its coordinator.
    expect(h.db.getWorkerDispatch(dispatchId)?.state).not.toMatch(/stopped|abandoned/)
  })

  it('stays unconfirmed for a read that is not only shown (the bot and its connectors)', async () => {
    const dispatchId = await goneWorker()
    expect((await readDispatchWorkers(h.runtime, [dispatchId]))[0]).toMatchObject({
      state: 'unverifiable'
    })
  })

  it('stays unconfirmed while its pane still holds a terminal', async () => {
    await goneWorker()
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockReturnValue('term_reissued')
    expect((await sessionWorkers())[0]!.state).toBe('unverifiable')
  })

  it('stays unconfirmed when its process answers under a reminted handle', async () => {
    await goneWorker()
    vi.spyOn(h.runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(
      'term_reminted'
    )
    vi.spyOn(h.runtime, 'resolveTerminalIdentity').mockImplementation((handle) => ({
      handle,
      live: handle === 'term_reminted'
    }))
    expect((await sessionWorkers())[0]!.state).toBe('unverifiable')
  })

  it('stays unconfirmed while the graph is unsettled or reloads, or when a read cannot tell', async () => {
    await goneWorker()
    const census = vi.spyOn(h.runtime, 'refreshAuthoritativeTerminalInventory')
    census.mockResolvedValue(null)
    expect((await sessionWorkers())[0]!.state).toBe('unverifiable')

    census.mockResolvedValue(() => false)
    expect((await sessionWorkers())[0]!.state).toBe('unverifiable')

    census.mockResolvedValue(() => true)
    vi.spyOn(h.runtime, 'resolveTerminalIdentity').mockImplementation(() => {
      throw new Error('graph_not_ready')
    })
    expect((await sessionWorkers())[0]!.state).toBe('unverifiable')
  })

  // Each worker runs in its own terminal, pane and process, as the harness's one worker does.
  async function goneWorkers(count: number): Promise<string[]> {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const handle = `term_gone_${index}`
      const paneKey = `tab_gone_${index}:cccccccc-cccc-4ccc-8ccc-cccccccccc0${index}`
      const incarnation = `runtime_test:${handle}:1`
      const own = <A extends unknown[], R>(
        spy: { getMockImplementation: () => ((...args: A) => R) | undefined },
        mine: R
      ) => {
        const prior = spy.getMockImplementation()
        return (...args: A): R => (args[0] === handle ? mine : prior!(...args))
      }
      const paneSpy = vi.spyOn(h.runtime, 'getTerminalPaneKey')
      paneSpy.mockImplementation(own(paneSpy, paneKey))
      const incarnationSpy = vi.spyOn(h.runtime, 'getTerminalProcessIncarnation')
      incarnationSpy.mockImplementation(own(incarnationSpy, incarnation))
      const authoritySpy = vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority')
      const harnessAuthority = authoritySpy.getMockImplementation()!('term_worker')!
      authoritySpy.mockImplementation(
        own(authoritySpy, {
          ...harnessAuthority,
          terminalHandle: handle,
          paneKey,
          processIncarnation: incarnation
        })
      )
      vi.spyOn(h.runtime, 'createTerminal').mockResolvedValueOnce({
        handle,
        worktreeId: 'repo::worktree',
        title: 'worker'
      })
      vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValueOnce({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      vi.spyOn(h.runtime, 'sendTerminalAgentPrompt').mockResolvedValueOnce({
        handle,
        accepted: true,
        bytesWritten: 1
      })
      ids.push(await goneWorker())
    }
    return ids
  }

  it('shows each worker whose terminal ended as stopped', async () => {
    const ids = await goneWorkers(3)
    const workers = await sessionWorkers()
    expect(workers.map((worker) => worker.dispatchId).sort()).toEqual([...ids].sort())
    expect(workers.every((worker) => worker.state === 'stopped')).toBe(true)
  })

  it('still checks each worker on its own against the shared census', async () => {
    const ids = await goneWorkers(3)
    const held = h.db.listWorkerTerminalResources({ dispatchIds: [ids[1]!] })[0]!.paneKey
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === held ? 'term_reissued' : null
    )
    const states = new Map((await sessionWorkers()).map((w) => [w.dispatchId, w.state]))
    expect(ids.map((id) => states.get(id))).toEqual(['stopped', 'unverifiable', 'stopped'])
  })

  it('keeps every worker unconfirmed when the one census cannot vouch for its hosts', async () => {
    await goneWorkers(3)
    const census = vi.spyOn(h.runtime, 'refreshAuthoritativeTerminalInventory')
    census.mockResolvedValue(null)
    const workers = await sessionWorkers()
    expect(workers.map((worker) => worker.state)).toEqual([
      'unverifiable',
      'unverifiable',
      'unverifiable'
    ])

    census.mockRejectedValue(new Error('controller_unavailable'))
    expect((await sessionWorkers()).every((worker) => worker.state === 'unverifiable')).toBe(true)
  })

  it('leaves a coordinator-only worker read unverifiable', async () => {
    const ids = await goneWorkers(2)
    const workers = await readDispatchWorkers(h.runtime, ids)
    expect(workers.every((worker) => worker.state === 'unverifiable')).toBe(true)
  })

  it('leaves a settled worker as it settled', async () => {
    const dispatchId = await goneWorker()
    const [worker] = await sessionWorkers()
    h.settle(worker!.taskId, dispatchId, 'succeeded')
    expect((await sessionWorkers())[0]).toMatchObject({ state: 'completed' })
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
  it('calls a proven exit without a report stopped', () => {
    expect(
      sessionWorkerState(
        { outcome: 'in_progress', liveness: { verdict: 'exited', source: 'execution_host' } },
        { workerState: 'ready' }
      )
    ).toBe('stopped')
  })
  it('reports a failed outcome even while the worker is live', () => {
    expect(
      sessionWorkerState({ outcome: 'failed', liveness: live }, { workerState: 'failed' })
    ).toBe('failed')
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
