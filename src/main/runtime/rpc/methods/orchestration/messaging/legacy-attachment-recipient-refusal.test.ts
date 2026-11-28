// A terminal working another Orca's Task reads only that Task's mail, so mail addressed to its
// handle on this server is refused before any row is written, never stored where nothing reads it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const LEGACY = 'term_legacy'
const PLAIN = 'term_plain'
const LEGACY_PANE = 'tab_legacy:33333333-3333-4333-8333-333333333333'
const PLAIN_PANE = 'tab_plain:44444444-4444-4444-8444-444444444444'
const FORMER_PANE = 'tab_former:55555555-5555-4555-8555-555555555555'
const DISPATCH = 'ctx_legacy_home'
const WORKTREE = 'repo::shared'
const REFUSED = { effectsApplied: false }

describe('mail to a terminal working another Orca Task', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let livePanes: Record<string, string>

  afterEach(() => harness.cleanup())

  function setup(): void {
    ;({ db, runtime, ctx } = harness.setup())
    livePanes = {
      term_coord: harness.coordinatorPaneKey,
      [LEGACY]: LEGACY_PANE,
      [PLAIN]: PLAIN_PANE
    }
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => livePanes[handle] ?? null)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  }

  function attachLegacy(ready = true): void {
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: DISPATCH,
      taskId: 'task_home',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_request',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH,
      paneKey: LEGACY_PANE,
      processIncarnation: `runtime_test:${LEGACY}:1`,
      worktreeId: WORKTREE,
      terminalHandle: LEGACY,
      setupState: 'not_applicable',
      effects: [],
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      terminalOwnership: 'created'
    })
    if (ready) {
      db.markRemoteAttachmentReady(DISPATCH)
    }
  }

  const mailTo = (handle: string): unknown =>
    db.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE to_handle = ?').get(handle)
  const send = (to: string) =>
    harness.call('orchestration.send', { from: 'term_coord', to, subject: 'hi', body: 'b' }, ctx)

  it('refuses a point send before write, by live pane and by retained handle, until it settles', async () => {
    setup()
    attachLegacy()
    await expect(send(LEGACY)).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: `${LEGACY} is working a Task for another Orca; mail can't reach it there. Message that Task's coordinator. Nothing was sent.`,
      data: REFUSED
    })
    delete livePanes[LEGACY]
    await expect(send(LEGACY)).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(mailTo(LEGACY)).toEqual({ n: 0 })

    livePanes[LEGACY] = LEGACY_PANE
    db.settleRemoteAttachmentInRelayTransaction(DISPATCH, 'succeeded')
    await expect(send(LEGACY)).resolves.toMatchObject({ message: { to_handle: LEGACY } })
  })

  it('refuses a point send while the attachment is starting, behind a local Dispatch', async () => {
    setup()
    attachLegacy(false)
    await expect(send(LEGACY)).rejects.toMatchObject({ code: 'dispatch_inactive', data: REFUSED })
    expect(mailTo(LEGACY)).toEqual({ n: 0 })

    const task = db.createTask({ spec: 'local work' })
    const dispatch = createRootDispatch(db, task.id, LEGACY, LEGACY_PANE)
    await expect(send(LEGACY)).resolves.toMatchObject({
      message: { to_handle: `dispatch:${dispatch.id}` }
    })
  })

  it('keeps other group deliveries, reports the refused member, and refuses an all-refused group', async () => {
    setup()
    attachLegacy()
    type TerminalList = Awaited<ReturnType<OrcaRuntimeService['listTerminals']>>
    const listed = (handles: string[]) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: group addressing reads only handle and worktreeId.
      const list = {
        terminals: handles.map((handle) => ({ handle, worktreeId: WORKTREE }))
      } as unknown as TerminalList
      vi.spyOn(runtime, 'listTerminals').mockResolvedValue(list)
    }

    listed([LEGACY, PLAIN])
    await expect(send(`@worktree:${WORKTREE}`)).resolves.toMatchObject({
      recipients: 1,
      messages: [{ to_handle: PLAIN }],
      warnings: expect.arrayContaining([
        expect.objectContaining({
          recipient: LEGACY,
          message: expect.stringContaining('working a Task for another Orca')
        })
      ])
    })
    expect([mailTo(LEGACY), mailTo(PLAIN)]).toEqual([{ n: 0 }, { n: 1 }])

    listed([LEGACY])
    await expect(send(`@worktree:${WORKTREE}`)).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: expect.stringContaining("Message that Task's coordinator. Nothing was sent."),
      data: REFUSED
    })
    expect(mailTo(LEGACY)).toEqual({ n: 0 })
  })

  /** Attach the worker once routing has resolved the reply's recipient, before the reply is stored. */
  function attachWhileReplyAwaits(alsoDispatchLocally = false): void {
    let resolved = false
    const owners = db.getActiveDispatchMailboxOwners.bind(db)
    vi.spyOn(db, 'getActiveDispatchMailboxOwners').mockImplementation((handle, paneKey) => {
      resolved ||= handle === LEGACY
      return owners(handle, paneKey)
    })
    const identity = db.getActiveDispatchForIdentity.bind(db)
    vi.spyOn(db, 'getActiveDispatchForIdentity').mockImplementation((handle, paneKey) => {
      if (resolved && !db.getRemoteDispatchAttachment(DISPATCH)) {
        attachLegacy()
        if (alsoDispatchLocally) {
          createRootDispatch(db, db.createTask({ spec: 'local work' }).id, LEGACY, LEGACY_PANE)
        }
      }
      return identity(handle, paneKey)
    })
  }
  const reply = (id: string) =>
    harness.call('orchestration.reply', { id, from: 'term_coord', body: 'answer' }, ctx)

  it('refuses a reply to such a terminal, including one attached while the reply awaited', async () => {
    setup()
    const question = db.insertMessage({ from: LEGACY, to: 'term_coord', subject: 'q', body: '?' })
    attachWhileReplyAwaits()
    await expect(reply(question.id)).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: expect.stringContaining('No reply was sent.'),
      data: REFUSED
    })
    expect(db.getRemoteDispatchAttachment(DISPATCH)?.state).toBe('ready')
    await expect(reply(question.id)).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(mailTo(LEGACY)).toEqual({ n: 0 })
    expect(db.getMessageById(question.id)?.read).toBeFalsy()
  })

  it("refuses a reply routed to the sender's former Run once it attached while the reply awaited", async () => {
    setup()
    const former = db.createRun({
      objective: 'Former Run',
      coordinatorHandle: LEGACY,
      coordinatorPaneKey: FORMER_PANE
    })
    const question = db.insertMessage({ from: LEGACY, to: 'term_coord', subject: 'q', body: '?' })
    attachWhileReplyAwaits()
    await expect(reply(question.id)).rejects.toMatchObject({
      code: 'capability_unsupported',
      data: REFUSED
    })
    expect(mailTo(`run:${former.id}`)).toEqual({ n: 0 })
    expect(db.getMessageById(question.id)?.read).toBeFalsy()
  })

  it('refuses a reply still bound for the terminal once a local Dispatch took it during the wait', async () => {
    setup()
    const question = db.insertMessage({ from: LEGACY, to: 'term_coord', subject: 'q', body: '?' })
    attachWhileReplyAwaits(true)
    await expect(reply(question.id)).rejects.toMatchObject({
      code: 'capability_unsupported',
      data: REFUSED
    })
    expect(mailTo(LEGACY)).toEqual({ n: 0 })
    expect(db.getMessageById(question.id)?.read).toBeFalsy()
  })

  // Regression guard: main already refuses this in the shared access check.
  it('keeps refusing a paired caller that names --on for a worker start', async () => {
    setup()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the access check reads only kind and peerRun.
    const peer = {
      kind: 'peer',
      peerRun: { run_id: 'run-home', home_label: 'Home Orca' }
    } as unknown as RpcContext['orchestrationCaller']
    await expect(
      harness.call(
        'orchestration.workerStart',
        { spec: 'work', on: 'other-server', from: 'term_coord' },
        { ...ctx, orchestrationCaller: peer }
      )
    ).rejects.toMatchObject({ code: 'forbidden', data: REFUSED })
  })
})
