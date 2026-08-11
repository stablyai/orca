import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { SenderLivenessEvidence } from '../../../../shared/orchestration-sender-liveness'

const COORDINATOR_PANE_KEY = 'tab_coord:11111111-1111-4111-8111-111111111111'
const WORKER_PANE_KEY = 'tab_worker:22222222-2222-4222-8222-222222222222'

type CheckResult = {
  deliveryId: string | null
  replayed?: boolean
  count: number
  formatted?: string
  messages: { id: string; subject: string; senderLiveness?: SenderLivenessEvidence }[]
}

describe('orchestration.check sender liveness', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runId: string
  let agentStatusRows: AgentStatusIpcPayload[]

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    agentStatusRows = []
    runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: () => agentStatusRows
    })
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? COORDINATOR_PANE_KEY
        : handle === 'term_worker'
          ? WORKER_PANE_KEY
          : null
    )
    vi.spyOn(runtime, 'getAgentStatusTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === WORKER_PANE_KEY ? 'term_worker' : undefined
    )
    runId = db.createRun({
      objective: 'Supervised run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
    ctx = { runtime }
  }

  async function check(params: Record<string, unknown>): Promise<CheckResult> {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === 'orchestration.check')
    if (!method) {
      throw new Error('orchestration.check is not registered')
    }
    const parsed = method.params ? method.params.parse({ terminal: 'term_coord', ...params }) : {}
    return (await method.handler(parsed, ctx)) as CheckResult
  }

  function startReadyWorker(options: { federated?: boolean } = {}): string {
    const task = db.createTask({ spec: 'worker work', runId })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      ...(options.federated
        ? {
            federation: {
              environmentId: 'env_remote',
              environmentName: 'remote',
              peerFingerprint: 'peer_fingerprint',
              protocolVersion: 1
            }
          }
        : {})
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'pty_1:1',
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'complete'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return dispatch.id
  }

  function workerIsWorking(state: AgentStatusIpcPayload['state'] = 'working'): void {
    const now = Date.now()
    agentStatusRows = [
      {
        paneKey: WORKER_PANE_KEY,
        terminalHandle: 'term_worker',
        state,
        prompt: 'implement the change',
        connectionId: null,
        receivedAt: now - 2_000,
        stateStartedAt: now - 30_000
      }
    ]
  }

  function send(subject: string, options: { from?: string; senderPaneKey?: string } = {}): string {
    return db.insertMessage({
      from: options.from ?? 'term_worker',
      to: `run:${runId}`,
      subject,
      type: 'status',
      runId,
      senderPaneKey: options.senderPaneKey ?? WORKER_PANE_KEY
    }).id
  }

  it('carries per-message liveness evidence for a local dispatch', async () => {
    setup()
    const dispatchId = startReadyWorker()
    workerIsWorking()
    send('first')
    send('second')

    const result = await check({})

    expect(result.messages.map((message) => message.senderLiveness)).toEqual([
      expect.objectContaining({
        state: 'working',
        source: 'agent_status',
        paneKey: WORKER_PANE_KEY,
        dispatch: { id: dispatchId, state: 'ready' }
      }),
      expect.objectContaining({ state: 'working', source: 'agent_status' })
    ])
    expect(result.messages[0].senderLiveness?.turnStartedAt).toEqual(expect.any(String))
  })

  it('returns an explicit unknown for a federated sender', async () => {
    setup()
    const dispatchId = startReadyWorker({ federated: true })
    workerIsWorking()
    db.insertMessage({
      from: `dispatch:${dispatchId}`,
      to: `run:${runId}`,
      subject: 'remote progress',
      type: 'status',
      runId
    })

    const result = await check({})

    expect(result.messages[0].senderLiveness).toMatchObject({
      state: 'unknown',
      source: 'federated',
      observedAt: null,
      turnStartedAt: null,
      dispatch: { id: dispatchId, state: 'ready' }
    })
  })

  it('returns an explicit unknown for a sender the runtime cannot resolve', async () => {
    setup()
    send('orphaned', {
      from: 'term_gone',
      senderPaneKey: 'tab_gone:33333333-3333-4333-8333-333333333333'
    })

    const result = await check({})

    expect(result.messages[0].senderLiveness).toMatchObject({
      state: 'unknown',
      source: 'sender_unresolved'
    })
    expect(result.messages[0].senderLiveness?.dispatch).toBeUndefined()
  })

  it('returns unknown for a sender whose harness exposes no semantic status', async () => {
    setup()
    startReadyWorker()
    send('quiet harness')

    const result = await check({})

    expect(result.messages[0].senderLiveness).toMatchObject({
      state: 'unknown',
      source: 'no_agent_status'
    })
  })

  it('leaves the FIFO batch, replay and acknowledgment untouched', async () => {
    setup()
    startReadyWorker()
    workerIsWorking()
    send('one')
    send('two')

    const first = await check({})
    const replay = await check({})
    expect(first.messages.map((message) => message.subject)).toEqual(['one', 'two'])
    expect(replay.deliveryId).toBe(first.deliveryId)
    expect(replay.replayed).toBe(true)
    expect(replay.messages.map((message) => message.subject)).toEqual(['one', 'two'])

    send('three')
    const afterAck = await check({ ack: first.deliveryId })
    expect(afterAck.deliveryId).not.toBe(first.deliveryId)
    expect(afterAck.messages.map((message) => message.subject)).toEqual(['three'])
    expect(afterAck.messages[0].senderLiveness?.state).toBe('working')
  })

  it('keeps type filters as wake predicates, not message filters', async () => {
    setup()
    startReadyWorker()
    workerIsWorking()
    send('status only')
    const empty = await check({ types: 'worker_done', wait: true, timeoutMs: 1 })
    expect(empty.count).toBe(0)

    db.insertMessage({
      from: 'term_worker',
      to: `run:${runId}`,
      subject: 'done',
      type: 'worker_done',
      runId,
      senderPaneKey: WORKER_PANE_KEY
    })
    const delivery = await check({ types: 'worker_done' })
    expect(delivery.messages.map((message) => message.subject)).toEqual(['status only', 'done'])
    expect(delivery.messages.every((message) => message.senderLiveness?.state === 'working')).toBe(
      true
    )
  })

  it('renders the evidence compactly in the formatted banner', async () => {
    setup()
    startReadyWorker()
    workerIsWorking()
    send('progress')

    const result = await check({ format: true })

    expect(result.formatted).toContain('[Sender: working,')
    expect(result.formatted).toContain('via agent_status')
  })

  it('still formats an injected Delivery that arrives during a wait', async () => {
    setup()
    startReadyWorker()
    workerIsWorking()

    const waiting = check({ wait: true, inject: true, timeoutMs: 5_000 })
    // Why: the waiter resolves on notify, so publish the message the way the send path does.
    await Promise.resolve()
    send('arrived mid-wait')
    runtime.notifyMessageArrived(`run:${runId}`, 'status')
    const result = await waiting

    expect(result.messages.map((message) => message.subject)).toEqual(['arrived mid-wait'])
    expect(result.formatted).toContain('From: TERM_WORKER')
    expect(result.formatted).toContain('[Sender: working,')
  })

  it('carries evidence on a non-consuming peek', async () => {
    setup()
    startReadyWorker()
    workerIsWorking()
    const messageId = send('peeked')

    const peeked = await check({ peek: true, unread: false })

    expect(peeked.messages[0].senderLiveness?.state).toBe('working')
    expect(db.getMessageById(messageId)?.read).toBe(0)
  })
})
