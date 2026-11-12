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
      const { dispatchId } = setup()
      paneIncarnation = REPLACEMENT

      const checked = await check(WORKER_HANDLE, ctx, mode).catch((error: unknown) => error)

      expect(checkedBodies(checked)).not.toContain('Pre-bind instructions')
      expect(residualUnread(dispatchId)).toBe(true)
    }
  )

  it('leaves residual mail unread for a stale handle whose process recovery refused', async () => {
    const { dispatchId } = setup()
    liveHandle = REISSUED_HANDLE
    paneIncarnation = REPLACEMENT

    const checked = await check(WORKER_HANDLE, staleEnv()).catch((error: unknown) => error)

    expect(checkedBodies(checked)).not.toContain('Pre-bind instructions')
    expect(residualUnread(dispatchId)).toBe(true)
  })

  it('leaves residual mail unread for a stale handle checking the Run explicitly', async () => {
    const { dispatchId, leadRunId } = setup()
    liveHandle = REISSUED_HANDLE
    paneIncarnation = REPLACEMENT

    const checked = await check(WORKER_HANDLE, staleEnv(), { run: leadRunId }).catch(
      (error: unknown) => error
    )

    expect(checkedBodies(checked)).not.toContain('Pre-bind instructions')
    expect(residualUnread(dispatchId)).toBe(true)
  })
})
