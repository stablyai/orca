import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { RunRow } from '../../db/orchestration-records'
import {
  getRemoteDispatch,
  oweRemoteDispatchStop
} from '../../db/remote-owned/remote-dispatch-records'
import { recordRemoteStart, reserveRemotePlacement } from '../../db/remote-owned/remote-placements'
import { importRemoteOwnedItem } from '../../db/remote-owned/remote-owned-import'
import {
  getRemoteRunLink,
  openRemoteRunLink,
  remoteServerPin,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import { resendOwedRemoteActions, sendOwedRemoteStop } from './remote-owed-actions'

vi.mock('../relay/federation-relay-scheduler', async (original) => ({
  ...(await original<object>()),
  federationRelayRetryDelayMs: () => 5
}))

const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'

type Sent = { method: string; params: unknown; envelope: RuntimeOrchestrationEnvelope | undefined }
type Answer = { result: unknown } | { error: string }

const STOPPED = {
  dispatchId: 'ctx_b1',
  state: 'stopped',
  alreadySettled: false,
  processAction: 'closed_agent_terminal'
}

describe('what the coordinating Orca owes a paired server', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let run: RunRow
  let link: RemoteRunLinkRow
  let server: OrchestrationWorkerServer
  let sent: Sent[]
  let answers: Record<string, Answer[]>
  let beforeSend: () => Promise<void>
  let now: number

  // One per test: a stopped loop from an earlier test still finishing its pull must not take this one's items.
  const createTransport = (
    sent: Sent[],
    answers: Record<string, Answer[]>,
    pulls: unknown[][]
  ): OrchestrationEnvironmentTransport => ({
    resolve: () => server,
    hasEnvironment: () => true,
    call: async (_selector, method, params, _timeout, envelope, _revision, send) => {
      const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'runtime_b' }
      })
      if (method === 'status.get') {
        return ok({ capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] })
      }
      if (method === 'orchestration.peerMailPull') {
        await new Promise((resolve) => setImmediate(resolve))
        return ok({ items: pulls.shift() ?? [] })
      }
      await beforeSend()
      // The socket's own preparation runs last, as it does just before a real frame leaves.
      const prepared = send?.prepareRequest?.({ params, envelope, measure: () => 0 })
      sent.push({
        method,
        params: prepared?.params ?? params,
        envelope: prepared?.envelope ?? envelope
      })
      const answer = answers[method]?.shift() ?? { error: 'remote_runtime_unavailable' }
      return 'result' in answer
        ? ok(answer.result)
        : { id: method, ok: false, error: { code: answer.error, message: answer.error } }
    }
  })
  let pulls: unknown[][]

  beforeEach(() => {
    sent = []
    answers = {}
    pulls = []
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: createTransport(sent, answers, pulls)
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue('Mac A')
    runtime.setOrchestrationDb(db)
    server = {
      environmentId: 'env_b',
      name: 'devB',
      peerFingerprint: 'host_b',
      homePeerFingerprint: 'cred_a',
      pairingRevision: 1
    }
    beforeSend = async () => undefined
    now = 1_000_000
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORDINATOR_PANE : null
    )
    run = db.createRun({
      objective: 'Ship',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE
    })
    link = openRemoteRunLink(db, run.id, server)
  })

  afterEach(() => {
    runtime.stopOrchestrationFederationRelay()
    db.close()
  })

  function startedOnB(taskId = 'task_t', dispatchId = 'ctx_b1') {
    reserveRemotePlacement(db, {
      link,
      taskId,
      requestKey: `key_${taskId}`,
      create: { spec: 'work' }
    })
    recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId,
      dispatchId,
      requestKey: `key_${taskId}`
    })
    return getRemoteDispatch(db, dispatchId)!
  }

  const owed = () => getRemoteDispatch(db, 'ctx_b1')!
  const terminalItem = (sequence: number) => ({
    conversationId: link.conversation_id,
    sequence,
    messageId: `state_${sequence}`,
    kind: 'worker_state',
    payload: JSON.stringify({
      v: 1,
      id: `state_${sequence}`,
      homeRunId: run.id,
      peerRunId: 'run_on_b',
      dispatch: {
        id: 'ctx_b1',
        taskId: 'task_t',
        status: 'completed',
        workerState: 'succeeded',
        lastFailure: null,
        agent: null
      },
      task: { status: 'completed', result: 'done' },
      correctedUnobservedPrompt: false,
      removed: null
    })
  })
  const stopKeys = () =>
    sent
      .filter((s) => s.method === 'orchestration.workerStop')
      .map((s) => s.envelope?.orchestrationRequestId)
  const resend = () =>
    resendOwedRemoteActions(runtime, db, 'env_b', {
      now: () => (now += 120_000)
    })

  describe('#2 owed stop', () => {
    it('reuses the key while the server does not answer, so its pending receipt completes the same stop', async () => {
      startedOnB()
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      await resend()
      await resend()
      answers['orchestration.workerStop'] = [{ result: STOPPED }]
      await resend()
      expect(stopKeys()).toEqual(['stop-1.0:ctx_b1', 'stop-1.0:ctx_b1', 'stop-1.0:ctx_b1'])
      expect(owed().stop_owed).toBe(0)
    })

    it('keeps the debt on a completed stop_unknown and runs the stop again under a fresh key', async () => {
      startedOnB()
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      answers['orchestration.workerStop'] = [
        { result: { ...STOPPED, state: 'stop_unknown' } },
        { error: 'dispatch_inactive' },
        { result: STOPPED }
      ]
      await resend()
      await resend()
      expect(owed().stop_owed).toBe(1)
      await resend()
      expect(stopKeys()).toEqual(['stop-1.0:ctx_b1', 'stop-1.1:ctx_b1', 'stop-1.2:ctx_b1'])
      expect(owed().stop_owed).toBe(0)
    })

    it('counts one intent once, and lets an older stop finishing late clear nothing newer or change the record', async () => {
      startedOnB()
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      expect(owed().stop_count).toBe(1)
      let release!: () => void
      beforeSend = () => new Promise<void>((resolve) => (release = resolve))
      answers['orchestration.workerStop'] = [{ result: STOPPED }]
      const older = sendOwedRemoteStop(runtime, owed())
      await vi.waitFor(() => expect(release).toBeDefined())
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_2')
      release()
      await older
      expect(owed()).toMatchObject({
        stop_owed: 1,
        stop_count: 2,
        status: 'pending',
        worker_state: null
      })
    })
  })

  describe('#2 stop intents', () => {
    it('owes a stop of a finished worker, whose helpers may still run, until the server proves it', async () => {
      startedOnB()
      importRemoteOwnedItem(db, remoteServerPin(server), terminalItem(1))
      expect(oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')?.stopCount).toBe(1)
      expect(owed().stop_owed).toBe(1)
      answers['orchestration.workerStop'] = [
        {
          result: {
            ...STOPPED,
            alreadySettled: true,
            helpers: [{ dispatchId: 'ctx_h', creatorDispatchId: 'ctx_b1', outcome: 'stopped' }]
          }
        }
      ]
      await resend()
      expect(owed().stop_owed).toBe(0)
    })
  })

  describe('#1 Run cancel', () => {
    it('sends nothing once a reset lands while a forward waits for the socket', async () => {
      startedOnB()
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      let release!: () => void
      beforeSend = () => new Promise<void>((resolve) => (release = resolve))
      const pending = sendOwedRemoteStop(runtime, owed())
      await vi.waitFor(() => expect(release).toBeDefined())
      db.resetTasks()
      release()
      await expect(pending).rejects.toMatchObject({ code: 'remote_link_closed' })
      expect(sent).toEqual([])
    })

    it('resends a lost reply under the same key, a partial stop under a new attempt, until none remain', async () => {
      startedOnB()
      db.resetAll()
      const key = getRemoteRunLink(db, link.conversation_id)!.cancel_key!
      expect(key).toMatch(/^cancel:/)
      answers['orchestration.peerRunCancel'] = [
        { error: 'runtime_timeout' },
        { result: { remaining: 1 } },
        { result: { remaining: 0 } }
      ]
      await resend()
      await resend()
      await resend()
      const cancels = sent.filter((s) => s.method === 'orchestration.peerRunCancel')
      expect(cancels.map((s) => s.envelope?.orchestrationRequestId)).toEqual([
        `${key}.0`,
        `${key}.0`,
        `${key}.1`
      ])
      expect(cancels[0]!.envelope?.orchestrationPeerRun).toEqual({
        runId: run.id,
        conversationId: link.conversation_id,
        label: 'Mac A'
      })
      expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('closed')
      await resend()
      expect(sent.filter((s) => s.method === 'orchestration.peerRunCancel')).toHaveLength(3)
    })

    it('re-arms the pull loop on reset, so the cancel goes out without another command', async () => {
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      answers['orchestration.peerRunCancel'] = [{ result: { remaining: 0 } }]
      await dispatcher.dispatch({
        id: 'reset',
        authToken: 'local',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'reset_1',
        method: 'orchestration.reset',
        params: { tasks: true }
      })
      await vi.waitFor(() =>
        expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('closed')
      )
    })
  })

  describe('S7 re-pair while a send waits', () => {
    it('closes the link and sends nothing when the pairing changes before the frame leaves', async () => {
      startedOnB()
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      let release!: () => void
      beforeSend = () => new Promise<void>((resolve) => (release = resolve))
      const pending = sendOwedRemoteStop(runtime, owed())
      await vi.waitFor(() => expect(release).toBeDefined())
      server = { ...server, peerFingerprint: 'host_b_new' }
      release()
      await expect(pending).rejects.toMatchObject({ code: 'server_pairing_changed' })
      expect(sent).toEqual([])
      expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('closed')
      expect(owed().stop_owed).toBe(0)
    })
  })

  describe('S8 pull loop', () => {
    it('acknowledges what it imported before an unreadable item, and never that item', async () => {
      startedOnB()
      const state = (seq: number, payload?: string) => ({
        conversationId: link.conversation_id,
        sequence: seq,
        messageId: `state_${seq}`,
        kind: 'worker_state',
        payload:
          payload ??
          JSON.stringify({
            v: 1,
            id: `state_${seq}`,
            homeRunId: run.id,
            peerRunId: 'run_on_b',
            dispatch: {
              id: 'ctx_b1',
              taskId: 'task_t',
              status: 'dispatched',
              workerState: 'ready',
              lastFailure: null,
              agent: null
            },
            task: { status: 'dispatched', result: null },
            correctedUnobservedPrompt: false,
            removed: null
          })
      })
      const otherRun = db.createRun({
        objective: 'Other',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      const other = openRemoteRunLink(db, otherRun.id, server)
      const otherItem = {
        ...state(7),
        conversationId: other.conversation_id,
        payload: state(7).payload.replace(run.id, otherRun.id)
      }
      pulls.push([state(1), { ...state(2), kind: 'worker_future' }, state(3), otherItem])
      answers['orchestration.peerMailAck'] = [{ result: { acknowledged: 1 } }]
      runtime.ensureOrchestrationFederationRelay()
      await vi.waitFor(() =>
        expect(sent.some((s) => s.method === 'orchestration.peerMailAck')).toBe(true)
      )
      runtime.stopOrchestrationFederationRelay()
      const acks = sent.filter((s) => s.method === 'orchestration.peerMailAck')
      expect(acks.map((s) => s.params)).toEqual([
        {
          acknowledgments: [
            { conversationId: link.conversation_id, throughSequence: 1 },
            { conversationId: other.conversation_id, throughSequence: 7 }
          ]
        }
      ])
      expect(getRemoteRunLink(db, link.conversation_id)).toMatchObject({
        last_imported_sequence: 1,
        last_error: expect.stringContaining('kind worker_future')
      })
    })
  })
})
