import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { generateId } from '../../../../orchestration/db/generated-id'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcResponse } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { startWorker } from '../worker/workers'
import { peerCoordinatorCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'

const WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_o:22222222-2222-4222-8222-222222222222'
const LOCAL_PANE = 'tab_l:33333333-3333-4333-8333-333333333333'
const PAIRED = {
  authenticatedCallerFingerprint: 'fingerprint_a',
  pairedDeviceId: 'device_a',
  clientKind: 'runtime' as const
}

describe('a paired Orca coordinating its Run on this server', () => {
  let dir: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let conversationId: string
  let sequence = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-peer-coordinator-'))
    db = new OrchestrationDb(join(dir, 'b.db'))
    runtime = new OrcaRuntimeService(null)
    const panes: Record<string, string> = {
      term_w: WORKER_PANE,
      term_o: OTHER_PANE,
      term_l: LOCAL_PANE
    }
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => panes[handle] ?? null)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes[handle] ?? null
    )
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    conversationId = generateId('peerconv')
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function peerCall(
    method: string,
    params: Record<string, unknown>,
    options: { requestId?: string; conversation?: string } = {}
  ): Promise<RpcResponse> {
    sequence += 1
    return dispatcher.dispatch(
      {
        id: `peer_${sequence}`,
        authToken: 'token',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationPeerRun: {
          runId: 'run_home',
          conversationId: options.conversation ?? conversationId,
          label: 'devA'
        },
        ...(options.requestId ? { orchestrationRequestId: options.requestId } : {})
      },
      PAIRED
    )
  }

  function localCall(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    sequence += 1
    return dispatcher.dispatch({
      id: `local_${sequence}`,
      authToken: 'token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
  }

  function peerRunId(): string {
    return db.getPeerRunForConversation(conversationId)!.run_id
  }

  /** The peer's Run with one worker in it, and a local Run with another. */
  async function twoRuns() {
    await peerCall('orchestration.runCurrent', {})
    const peerTask = db.createTask({ spec: 'peer work', runId: peerRunId() })
    const peerWork = createRootDispatch(db, peerTask.id, 'term_w', WORKER_PANE)
    const localRun = db.createRun({
      objective: 'local',
      coordinatorHandle: 'term_l',
      coordinatorPaneKey: LOCAL_PANE
    })
    const localTask = db.createTask({ spec: 'local work', runId: localRun.id })
    const localWork = createRootDispatch(db, localTask.id, 'term_o', OTHER_PANE)
    return { peerWork, localRun, localWork }
  }

  async function pull(id: string, params: Record<string, unknown> = {}) {
    const response = await dispatcher.dispatch(
      {
        id,
        authToken: 'token',
        method: 'orchestration.peerMailPull',
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      },
      PAIRED
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pull's result schema; a refusal reads as an empty page.
    return (response.ok ? response.result : { items: [] }) as {
      items: { conversationId: string; kind: string }[]
    }
  }

  function refused(response: RpcResponse): string | undefined {
    return response.ok ? undefined : response.error.code
  }

  it("writes the peer's Run when its frame arrives, before the call awaits anything", () => {
    const pending = peerCall('orchestration.runCurrent', {})
    const run = db.getPeerRunForConversation(conversationId)
    expect(run).toMatchObject({ home_run_id: 'run_home', home_label: 'devA', state: 'open' })
    expect(db.getRun(run!.run_id)).toBeDefined()
    return pending
  })

  it('admits a peer Run only from a runtime pairing', async () => {
    sequence += 1
    const response = await dispatcher.dispatch(
      {
        id: 'mobile',
        authToken: 'token',
        method: 'orchestration.runCurrent',
        params: {},
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationPeerRun: { runId: 'run_home', conversationId, label: 'devA' }
      },
      { ...PAIRED, clientKind: 'mobile' }
    )
    expect(refused(response)).toBe('mail_requires_server_pairing')
    expect(db.getPeerRunForConversation(conversationId)).toBeUndefined()
  })

  it('refuses commands that act on this server as a whole', async () => {
    const { localRun } = await twoRuns()
    expect(refused(await peerCall('orchestration.reset', { all: true }))).toBe('forbidden')
    expect(refused(await peerCall('orchestration.runUse', { id: localRun.id }))).toBe('forbidden')
    expect(db.getRun(localRun.id)).toBeDefined()
  })

  it("keeps another Run's worker out of reach by terminal, pane or session, but not its own", async () => {
    const { peerWork, localWork } = await twoRuns()
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run('33333333-3333-4333-8333-333333333334', localWork.id)

    for (const target of [
      { terminal: 'term_o' },
      { paneKey: OTHER_PANE },
      { sessionId: '33333333-3333-4333-8333-333333333334' }
    ]) {
      expect(
        refused(await peerCall('orchestration.workerKeepOpen', { ...target, keep: true }))
      ).toBe('forbidden')
    }
    expect(peerWork.assignee_handle).toBe('term_w')
    expect(
      (await peerCall('orchestration.workerKeepOpen', { terminal: 'term_w', keep: true })).ok
    ).toBe(true)
  })

  it('reads only its own Run from an unqualified worker list and inbox', async () => {
    const { peerWork, localRun } = await twoRuns()
    db.insertMessage({
      from: 'term_w',
      to: `run:${peerRunId()}`,
      subject: 'mine',
      runId: peerRunId()
    })
    db.insertMessage({
      from: 'term_o',
      to: `run:${localRun.id}`,
      subject: 'theirs',
      runId: localRun.id
    })

    const list = await peerCall('orchestration.workerList', { paginate: true })
    const inbox = await peerCall('orchestration.inbox', {})

    expect(list.ok && list.result).toMatchObject({
      workers: [{ dispatchId: peerWork.id, coordinatedFrom: 'devA' }],
      page: { total: 1 }
    })
    expect(inbox.ok && inbox.result).toMatchObject({ messages: [{ subject: 'mine' }], count: 1 })
  })

  it('sends and replies only inside its own Run, by any address form', async () => {
    const { localRun, localWork } = await twoRuns()
    const question = db.insertMessage({
      from: 'term_o',
      to: `run:${localRun.id}`,
      subject: 'Question',
      type: 'question',
      runId: localRun.id
    })
    for (const to of ['term_o', `dispatch:${localWork.id}`, `run:${localRun.id}`, '@all']) {
      expect(refused(await peerCall('orchestration.send', { to, subject: 'hi' }))).toBe('forbidden')
    }
    expect(refused(await peerCall('orchestration.reply', { id: question.id, body: 'yes' }))).toBe(
      'forbidden'
    )
  })

  it('cannot reach its former worker once that terminal coordinates local work', async () => {
    await twoRuns()
    db.createRun({
      objective: 'later local',
      coordinatorHandle: 'term_w',
      coordinatorPaneKey: WORKER_PANE
    })
    expect(refused(await peerCall('orchestration.send', { to: 'term_w', subject: 'hi' }))).toBe(
      'forbidden'
    )
  })

  it('refuses a start that would place in its workspace, which it has none of here', async () => {
    for (const worktree of ['current', 'new-child']) {
      const response = await peerCall('orchestration.workerStart', { spec: 'work', worktree })
      expect(response.ok ? undefined : response.error).toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('--on requires an exact remote worktree selector')
      })
    }
  })

  it('follows up with a finished worker where that worker ran, though it has no workspace here', async () => {
    await peerCall('orchestration.runCurrent', {})
    const peer = peerCoordinatorCaller(db.getPeerRunForConversation(conversationId)!)
    const placed = startWorker(
      { from: peer.address, run: peerRunId(), spec: 'One more thing' },
      {
        runtime,
        orchestrationMutation: undefined,
        orchestrationCompatibilityEvidence: undefined,
        orchestrationCaller: peer
      },
      {
        of: 'ctx_finished',
        addressed: 'ctx_finished',
        place: async () => {
          throw new Error('placed where the worker ran')
        }
      }
    )
    await expect(placed).rejects.toThrow('placed where the worker ran')
  })

  it("never answers one Run's cancel with another Run's receipt", async () => {
    const other = generateId('peerconv')
    await peerCall('orchestration.peerRunCancel', {}, { requestId: 'cancel:1.1' })
    const second = await peerCall(
      'orchestration.peerRunCancel',
      {},
      { requestId: 'cancel:1.1', conversation: other }
    )
    expect(second.ok && second.result).not.toMatchObject({ mutation: { replayed: true } })
  })

  it('stays the only coordinator of its Run: a local terminal cannot bind it', async () => {
    await twoRuns()
    const response = await localCall('orchestration.runUse', { id: peerRunId(), from: 'term_l' })
    expect(refused(response)).toBe('consumer_fenced')
    expect(db.getRun(peerRunId())?.coordinator_handle).toBe(`peer:${conversationId}`)
  })

  it('cannot be impersonated by a local caller declaring its address', async () => {
    await twoRuns()
    const address = `peer:${conversationId}`
    const mail = db.insertMessage({
      from: 'term_w',
      to: address,
      subject: 'done',
      runId: peerRunId()
    })
    const check = await localCall('orchestration.check', {
      terminal: address,
      terminalPaneKey: address
    })
    expect(refused(check)).toBe('forbidden')
    expect(db.getMessageById(mail.id)?.read).toBe(0)
    const send = await localCall('orchestration.send', {
      from: 'term_l',
      senderPaneKey: address,
      to: 'term_w',
      subject: 'hi'
    })
    expect(refused(send)).toBe('forbidden')
  })

  it('keeps work in its Run, helpers included, from calling on to another server', async () => {
    const { localRun } = await twoRuns()
    const helperTask = db.createTask({ spec: 'helper', runId: peerRunId() })
    createRootDispatch(db, helperTask.id, 'term_l', LOCAL_PANE)
    for (const [method, params] of [
      ['orchestration.send', { from: 'term_w', to: 'term_x', subject: 'hi', on: 'devC' }],
      ['orchestration.workerStart', { from: 'term_l', spec: 'more', on: 'devC' }]
    ] as const) {
      const response = await localCall(method, params)
      expect(response.ok ? undefined : response.error.message).toMatch(/coordinated from devA/)
    }
    expect(localRun.id).toBeDefined()
  })

  it('cancels over the ordinary stop and answers what it could not yet prove stopped', async () => {
    await peerCall('orchestration.runCurrent', {})
    const task = db.createTask({ spec: 'peer work', runId: peerRunId() })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 5
    })
    const remaining = async (requestId: string) => {
      const response = await peerCall('orchestration.peerRunCancel', {}, { requestId })
      return response.ok ? response.result : response.error
    }

    // A worker still starting cannot be stopped yet, so the cancel is owed again.
    expect(await remaining('cancel:1.1')).toMatchObject({ remaining: 1 })
    expect(db.getPeerRunForConversation(conversationId)?.state).toBe('closed')
    db.transitionLifecycle({ entity: 'worker', id: dispatch.id, from: 'starting', to: 'failed' })
    // A lost answer's retry replays it; a new attempt runs the stops again.
    expect(await remaining('cancel:1.1')).toMatchObject({
      remaining: 1,
      mutation: { replayed: true }
    })
    expect(await remaining('cancel:1.2')).toMatchObject({ remaining: 0 })
  })

  it('cancels a Run it never had, and closes it', async () => {
    const response = await peerCall('orchestration.peerRunCancel', {}, { requestId: 'cancel:1.1' })
    expect(response.ok && response.result).toMatchObject({ remaining: 0 })
    expect(db.getPeerRunForConversation(conversationId)?.state).toBe('closed')
    // A closed Run still admits its coordinator's cancel.
    const again = await peerCall('orchestration.peerRunCancel', {}, { requestId: 'cancel:1.2' })
    expect(again.ok && again.result).toMatchObject({ remaining: 0 })
  })

  it('gives every conversation a share of each pull, so an unimportable head starves no other', async () => {
    const stuck = conversationId
    const other = generateId('peerconv')
    await peerCall('orchestration.runCurrent', {})
    await peerCall('orchestration.runCurrent', {}, { conversation: other })
    const stuckRun = db.getPeerRunForConversation(stuck)!.run_id
    const otherRun = db.getPeerRunForConversation(other)!.run_id
    for (let index = 0; index < 60; index += 1) {
      db.insertMessage({
        from: 'term_w',
        to: `run:${stuckRun}`,
        subject: `s${index}`,
        runId: stuckRun
      })
    }
    db.insertMessage({ from: 'term_w', to: `run:${otherRun}`, subject: 'done', runId: otherRun })

    const items = await pull('pull')
    expect(items.items.filter((item) => item.conversationId === other)).toEqual([
      expect.objectContaining({ kind: 'worker_mail' })
    ])
  })

  it('fits every pending conversation in one page when they number fewer than its size', async () => {
    const conversations = Array.from({ length: 30 }, () => generateId('peerconv'))
    for (const conversation of conversations) {
      await peerCall('orchestration.runCurrent', {}, { conversation })
      const runId = db.getPeerRunForConversation(conversation)!.run_id
      for (const subject of ['one', 'two']) {
        db.insertMessage({ from: 'term_w', to: `run:${runId}`, subject, runId })
      }
    }
    const page = await pull('pull')
    expect(new Set(page.items.map((item) => item.conversationId)).size).toBe(30)
  })

  it('rotates the page when more conversations are pending than it holds, so none starves', async () => {
    const conversations = Array.from({ length: 51 }, () => generateId('peerconv'))
    for (const conversation of conversations) {
      await peerCall('orchestration.runCurrent', {}, { conversation })
      const runId = db.getPeerRunForConversation(conversation)!.run_id
      db.insertMessage({ from: 'term_w', to: `run:${runId}`, subject: 'stuck', runId })
    }
    const seen = new Set<string>()
    for (const id of ['pull_1', 'pull_2']) {
      for (const item of (await pull(id)).items) {
        seen.add(item.conversationId)
      }
    }
    expect(seen.size).toBe(51)
  })

  it('wakes a waiting pull when a worker in its Run changes state', async () => {
    await peerCall('orchestration.runCurrent', {})
    const task = db.createTask({ spec: 'peer work', runId: peerRunId() })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 5
    })
    db.acknowledgeFederationRelay({
      dispatchId: conversationId,
      direction: 'to_home',
      throughSequence: 1_000
    })
    // The pull's own deadline never passes, so only the state change can answer it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const waiting = pull('pull', { waitMs: 20_000 })
    await new Promise((resolve) => setImmediate(resolve))
    db.transitionLifecycle({ entity: 'worker', id: dispatch.id, from: 'starting', to: 'ready' })

    expect((await waiting).items).toEqual([expect.objectContaining({ kind: 'worker_state' })])
  })
})
