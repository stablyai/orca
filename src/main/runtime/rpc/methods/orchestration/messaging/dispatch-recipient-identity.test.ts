import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../../../../../shared/orca-session-address-test-fixture'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const PANE = 'tab_lead:22222222-2222-4222-9222-222222222222'
const OTHER = 'tab_other:33333333-3333-4333-8333-333333333333'
const SESSION = testOrcaSessionId('4bd46b4a-035b-41dd-a122-a9c29122ff11')

describe.each([false, true])('Dispatch recipient identity (settled=%s)', (settled) => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  let dispatch: ReturnType<typeof createRootDispatch>

  beforeEach(() => {
    state = h.setup()
    const task = state.db.createTask({ spec: 'lead' })
    dispatch = createRootDispatch(state.db, task.id, 'term_lead', PANE)
    if (settled) {
      state.db.completeDispatch(dispatch.id)
    }
    vi.spyOn(state.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_lead' ? PANE : h.coordinatorPaneKey
    )
  })
  afterEach(() => h.cleanup())

  function send() {
    return h.call(
      'orchestration.send',
      { from: 'term_coord', to: `dispatch:${dispatch.id}`, subject: 'follow up' },
      state.ctx
    )
  }
  function sessionRun() {
    state.db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(SESSION, dispatch.id)
    return state.db.createRun({
      objective: 'session lead',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: SESSION
    })
  }
  async function expectRun(runId: string) {
    if (settled) {
      await expect(send()).rejects.toMatchObject({
        code: 'dispatch_inactive',
        message: expect.stringContaining(`Send to run:${runId} instead`)
      })
      expect(state.db.getInbox()).toEqual([])
    } else {
      expect(await send()).toMatchObject({ message: { to_handle: `run:${runId}`, run_id: runId } })
    }
  }
  async function expectNoRedirect(unrelatedRun: string) {
    if (settled) {
      await expect(send()).rejects.toMatchObject({
        code: 'dispatch_inactive',
        message: expect.not.stringContaining(unrelatedRun)
      })
      expect(state.db.getInbox()).toEqual([])
    } else {
      expect(await send()).toMatchObject({
        message: { to_handle: `dispatch:${dispatch.id}`, run_id: dispatch.run_id }
      })
    }
  }

  it('uses a durable session binding without a live pane', async () => {
    const run = sessionRun()
    vi.mocked(state.runtime.getLiveTerminalPaneKey).mockReturnValue(null)
    await expectRun(run.id)
  })

  it('uses the recorded session instead of an unrelated Run now occupying the saved pane', async () => {
    const run = sessionRun()
    state.db.createRun({
      objective: 'new occupant',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: PANE
    })
    await expectRun(run.id)
  })

  it('ignores an old session column left behind by an older binary rebind', async () => {
    const run = sessionRun()
    state.db.db
      .prepare(
        'UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?, consumer_generation = consumer_generation + 1 WHERE id = ?'
      )
      .run('term_other', OTHER, run.id)
    await expectNoRedirect(run.id)
  })

  it('does not follow a closed handle to another occupant of its old pane', async () => {
    const run = state.db.createRun({
      objective: 'new occupant',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: PANE
    })
    vi.mocked(state.runtime.getLiveTerminalPaneKey).mockReturnValue(null)
    await expectNoRedirect(run.id)
  })

  it.each(['replacement:pty:2', null])(
    'does not redirect with a replaced or unverifiable process: %s',
    async (process) => {
      const run = state.db.createRun({
        objective: 'pane run',
        coordinatorHandle: 'term_lead',
        coordinatorPaneKey: PANE
      })
      state.db.db
        .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
        .run('original:pty:1', dispatch.id)
      vi.mocked(state.runtime.getTerminalProcessIncarnation).mockReturnValue(process)
      await expectNoRedirect(run.id)
      expect(state.db.getDispatchContextById(dispatch.id)?.status).toBe(
        settled ? 'completed' : dispatch.status
      )
    }
  )

  it('accepts a reminted tab half with the same pane leaf and process', async () => {
    const run = state.db.createRun({
      objective: 'same pane',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: PANE
    })
    vi.mocked(state.runtime.getLiveTerminalPaneKey).mockReturnValue(
      PANE.replace('tab_lead', 'tab_restored')
    )
    await expectRun(run.id)
  })
})
