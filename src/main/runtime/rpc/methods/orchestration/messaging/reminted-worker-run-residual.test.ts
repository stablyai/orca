// A worker whose pane later bound its own Run checks that Run's mailbox, which also drains mail left in
// its pre-bind Dispatch. That residual drain must hold the same process fence as the worker branch: a
// replacement process in the pane, or a stale handle recovery refused, never reads the old Dispatch mail.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const WORKER_HANDLE = 'term_worker-lead'
const REISSUED_HANDLE = 'term_worker-lead-reissued'
const WORKER_PANE = 'tab_lead:44444444-4444-4444-8444-444444444444'
const INCARNATION = 'wt::/repo/lead@@pty1:inc-original'
const REPLACEMENT = 'wt::/repo/lead@@pty1:inc-replacement'
const SUCCESSOR_HANDLE = 'term_worker-successor'
const SUCCESSOR_INCARNATION = 'wt::/repo/lead@@pty1:inc-successor'
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

describe('Run check draining a pre-bind Dispatch after its worker process changed', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  // The live handle in the worker pane and the process it runs; tests swap them to model a restart.
  let liveHandle = WORKER_HANDLE
  let paneIncarnation = INCARNATION

  afterEach(() => {
    harness.cleanup()
    liveHandle = WORKER_HANDLE
    paneIncarnation = INCARNATION
  })

  /** A worker Dispatch with unread mail, whose pane then bound a Run of its own. */
  function setup(): { dispatchId: string; leadRunId: string } {
    const { dispatchId } = setupDispatch()
    return { dispatchId, leadRunId: bindLeadRun() }
  }

  function bindLeadRun(): string {
    return db.createRun({
      objective: 'lead Run',
      coordinatorHandle: WORKER_HANDLE,
      coordinatorPaneKey: WORKER_PANE
    }).id
  }

  function setupDispatch(): { dispatchId: string } {
    ;({ db, runtime, ctx } = harness.setup())
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === liveHandle
          ? WORKER_PANE
          : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === liveHandle ? paneIncarnation : null
    )
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      (incarnation, hostScope) =>
        incarnation === paneIncarnation && hostScope === HOST_SCOPE ? liveHandle : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
    const task = db.createTask({ spec: 'lead that later coordinates its own Run' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      WORKER_HANDLE,
      WORKER_PANE,
      undefined,
      INCARNATION
    )
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(HOST_SCOPE, dispatch.id)
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'pre-bind',
      body: 'Pre-bind instructions',
      runId: dispatch.run_id
    })
    return { dispatchId: dispatch.id }
  }

  const residualUnread = (dispatchId: string) =>
    db.getUnreadMessages(`dispatch:${dispatchId}`).some((m) => m.body === 'Pre-bind instructions')

  const checkedBodies = (checked: unknown): string[] =>
    checked &&
    typeof checked === 'object' &&
    'messages' in checked &&
    Array.isArray(checked.messages)
      ? checked.messages.map((message: { body?: unknown }) => String(message.body))
      : []

  const check = (from: string, env: RpcContext, extra: Record<string, unknown> = {}) =>
    harness.call(
      'orchestration.check',
      { terminal: from, terminalPaneKey: WORKER_PANE, ...extra },
      env
    )

  const staleEnv = (): RpcContext => ({
    ...ctx,
    orchestrationCompatibilityEvidence: {
      terminalHandle: WORKER_HANDLE,
      paneKey: WORKER_PANE,
      launchToken: 'launch-token'
    }
  })

  it('drains the residual Dispatch mail for its own recorded process (control)', async () => {
    const { dispatchId, leadRunId } = setup()

    const checked = await check(WORKER_HANDLE, ctx)

    expect(checked).toMatchObject({ dispatchId })
    expect(checkedBodies(checked)).toContain('Pre-bind instructions')
    expect(db.getCurrentRunForPane(WORKER_PANE)?.id).toBe(leadRunId)
  })

  it.each([
    ['take', {}],
    ['peek', { peek: true }],
    ['history', { all: true }]
  ])(
    'leaves residual mail unread for a replacement process on the same handle (%s)',
    async (_label, mode) => {
      const { dispatchId, leadRunId } = setup()
      paneIncarnation = REPLACEMENT

      const checked = await check(WORKER_HANDLE, ctx, mode)

      expect(checked).toMatchObject({ runId: leadRunId })
      expect(checkedBodies(checked)).not.toContain('Pre-bind instructions')
      expect(residualUnread(dispatchId)).toBe(true)
    }
  )

  it('refuses a stale handle whose process recovery refused, before any mailbox is read', async () => {
    const { dispatchId } = setup()
    liveHandle = REISSUED_HANDLE
    paneIncarnation = REPLACEMENT

    await expect(check(WORKER_HANDLE, staleEnv())).rejects.toMatchObject({
      code: 'dispatch_inactive'
    })
    expect(residualUnread(dispatchId)).toBe(true)
  })

  it('leaves residual mail unread for a stale handle checking the Run explicitly', async () => {
    const { dispatchId, leadRunId } = setup()
    liveHandle = REISSUED_HANDLE
    paneIncarnation = REPLACEMENT

    await expect(check(WORKER_HANDLE, staleEnv(), { run: leadRunId })).rejects.toMatchObject({
      code: 'dispatch_inactive'
    })
    expect(residualUnread(dispatchId)).toBe(true)
  })

  describe('after a successor Dispatch took the pane and bound its Run', () => {
    /** The stale handle's Dispatch finished; a new worker process in the same pane runs a successor
     *  Dispatch with its own pre-bind mail, then binds a Run of its own. */
    function setupSuccessor(): { successorId: string; successorRunId: string } {
      const { dispatchId } = setupDispatch()
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
        .run(dispatchId)
      liveHandle = SUCCESSOR_HANDLE
      paneIncarnation = SUCCESSOR_INCARNATION
      const successor = createRootDispatch(
        db,
        db.createTask({ spec: 'successor lead' }).id,
        SUCCESSOR_HANDLE,
        WORKER_PANE,
        undefined,
        SUCCESSOR_INCARNATION
      )
      db.db
        .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
        .run(HOST_SCOPE, successor.id)
      db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${successor.id}`,
        subject: 'successor',
        body: 'Successor instructions',
        runId: successor.run_id
      })
      const successorRunId = db.createRun({
        objective: 'successor Run',
        coordinatorHandle: SUCCESSOR_HANDLE,
        coordinatorPaneKey: WORKER_PANE
      }).id
      return { successorId: successor.id, successorRunId }
    }

    const successorUnread = (successorId: string) =>
      db
        .getUnreadMessages(`dispatch:${successorId}`)
        .some((m) => m.body === 'Successor instructions')

    it.each([
      ['implicitly bound', () => ({})],
      ['naming the Run', (runId: string) => ({ run: runId })]
    ])(
      'refuses the stale handle without reading the successor mail (%s)',
      async (_label, extra) => {
        const { successorId, successorRunId } = setupSuccessor()

        await expect(check(WORKER_HANDLE, staleEnv(), extra(successorRunId))).rejects.toMatchObject(
          { code: 'dispatch_inactive' }
        )
        expect(successorUnread(successorId)).toBe(true)
      }
    )

    it('still serves the successor its own pre-bind mail through its Run (control)', async () => {
      const { successorId, successorRunId } = setupSuccessor()

      const checked = await check(SUCCESSOR_HANDLE, ctx)

      expect(checked).toMatchObject({ dispatchId: successorId })
      expect(checkedBodies(checked)).toContain('Successor instructions')
      expect(db.getCurrentRunForPane(WORKER_PANE)?.id).toBe(successorRunId)
    })
  })
})
