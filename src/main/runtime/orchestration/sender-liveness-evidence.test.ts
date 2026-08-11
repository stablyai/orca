import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  attachSenderLivenessEvidence,
  resolveSenderLivenessEvidence
} from './sender-liveness-evidence'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import type { MessageRow } from './types'

const WORKER_PANE_KEY = 'tab_worker:22222222-2222-4222-8222-222222222222'
const COORDINATOR_PANE_KEY = 'tab_coord:11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

describe('sender liveness evidence', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createRuntime(
    rows: AgentStatusIpcPayload[],
    options: { paneResolves?: boolean; handleResolves?: boolean } = {}
  ): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: () => rows
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(() =>
      options.handleResolves === false ? null : WORKER_PANE_KEY
    )
    vi.spyOn(runtime, 'getAgentStatusTerminalHandleForPaneKey').mockImplementation(() =>
      options.paneResolves === false ? undefined : 'term_worker'
    )
    return runtime
  }

  function statusRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    return {
      paneKey: WORKER_PANE_KEY,
      terminalHandle: 'term_worker',
      state: 'working',
      prompt: 'ship the feature',
      connectionId: null,
      receivedAt: NOW - 5_000,
      stateStartedAt: NOW - 60_000,
      ...overrides
    }
  }

  function createRunWithWorkerMessage(
    d: OrchestrationDb,
    options: { federated?: boolean; senderPaneKey?: string | null; from?: string } = {}
  ): { message: MessageRow; dispatchId: string } {
    const run = d.createRun({
      objective: 'Liveness evidence',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    })
    const task = d.createTask({ spec: 'work', runId: run.id })
    const { dispatch } = d.createStartingWorkerDispatch({
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
    d.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'pty_1:1',
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'complete'
    })
    d.markWorkerDispatchReady(dispatch.id)
    const message = d.insertMessage({
      from: options.from ?? 'term_worker',
      to: `run:${run.id}`,
      subject: 'progress',
      type: 'status',
      runId: run.id,
      senderPaneKey: options.senderPaneKey === undefined ? WORKER_PANE_KEY : undefined
    })
    return { message, dispatchId: dispatch.id }
  }

  it('reports a live sender that is mid-turn, with its last turn boundary', () => {
    const d = createDb()
    const { message, dispatchId } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([statusRow()])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toEqual({
      state: 'working',
      source: 'agent_status',
      observedAt: new Date(NOW - 5_000).toISOString(),
      turnStartedAt: new Date(NOW - 60_000).toISOString(),
      paneKey: WORKER_PANE_KEY,
      dispatch: { id: dispatchId, state: 'ready' }
    })
  })

  it('reports a live sender that finished its turn as idle', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([statusRow({ state: 'done' })])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'idle',
      source: 'agent_status'
    })
  })

  it('reports a blocked sender without promoting it to working or idle', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([statusRow({ state: 'blocked' })])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'blocked',
      source: 'agent_status'
    })
  })

  it('classifies a sender whose pane is gone as unknown', () => {
    const d = createDb()
    const { message, dispatchId } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([], { paneResolves: false, handleResolves: false })

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toEqual({
      state: 'unknown',
      source: 'sender_unresolved',
      observedAt: null,
      turnStartedAt: null,
      paneKey: WORKER_PANE_KEY,
      dispatch: { id: dispatchId, state: 'ready' }
    })
  })

  it('classifies a sender whose harness exposes no semantic status as unknown', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'unknown',
      source: 'no_agent_status',
      observedAt: null,
      turnStartedAt: null
    })
  })

  it('classifies a federated sender as unknown and keeps its dispatch state', () => {
    const d = createDb()
    const { message, dispatchId } = createRunWithWorkerMessage(d, {
      federated: true,
      from: 'dispatch:placeholder',
      senderPaneKey: null
    })
    const federatedMessage = { ...message, from_handle: `dispatch:${dispatchId}` }
    // Why: a fresh local status row must not leak into a remote sender's verdict.
    const runtime = createRuntime([statusRow()])

    expect(resolveSenderLivenessEvidence(runtime, d, federatedMessage, NOW)).toEqual({
      state: 'unknown',
      source: 'federated',
      observedAt: null,
      turnStartedAt: null,
      paneKey: WORKER_PANE_KEY,
      dispatch: { id: dispatchId, state: 'ready' }
    })
  })

  it('classifies stale evidence as unknown while keeping when it was last observed', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const observedAt = NOW - AGENT_STATUS_STALE_AFTER_MS - 1_000
    const runtime = createRuntime([
      statusRow({ receivedAt: observedAt, stateStartedAt: observedAt })
    ])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'unknown',
      source: 'stale_agent_status',
      observedAt: new Date(observedAt).toISOString(),
      turnStartedAt: null
    })
  })

  it('treats a restored row with no live confirmation as unknown', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([statusRow({ restoredUnconfirmed: true })])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'unknown',
      source: 'stale_agent_status'
    })
  })

  it('resolves from the recorded sender pane key before the live handle', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([statusRow()])
    const paneKeyForHandle = vi.spyOn(runtime, 'getTerminalPaneKey')

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'working'
    })
    expect(paneKeyForHandle).not.toHaveBeenCalled()
  })

  it('matches a status row whose pane key was reminted onto another tab', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([
      statusRow({ paneKey: 'tab_reminted:22222222-2222-4222-8222-222222222222' })
    ])

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toMatchObject({
      state: 'working',
      source: 'agent_status'
    })
  })

  it('degrades to unavailable instead of failing when evidence cannot be resolved', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const runtime = createRuntime([statusRow()])
    vi.spyOn(d, 'getActiveDispatchForIdentity').mockImplementation(() => {
      throw new Error('database is locked')
    })

    expect(resolveSenderLivenessEvidence(runtime, d, message, NOW)).toEqual({
      state: 'unknown',
      source: 'unavailable',
      observedAt: null,
      turnStartedAt: null,
      paneKey: WORKER_PANE_KEY
    })
  })

  it('stamps every message without reordering or mutating the batch', () => {
    const d = createDb()
    const { message } = createRunWithWorkerMessage(d)
    const second = { ...message, id: 'msg_second', subject: 'second' }
    const runtime = createRuntime([statusRow()])
    const observation = vi.spyOn(runtime, 'getSenderAgentTurnObservation')

    const stamped = attachSenderLivenessEvidence(runtime, d, [message, second], NOW)

    expect(stamped.map((row) => row.id)).toEqual([message.id, 'msg_second'])
    expect(stamped.every((row) => row.senderLiveness.state === 'working')).toBe(true)
    // Why: one resolution per distinct sender, not per message.
    expect(observation).toHaveBeenCalledTimes(1)
    expect(message).not.toHaveProperty('senderLiveness')
  })
})
