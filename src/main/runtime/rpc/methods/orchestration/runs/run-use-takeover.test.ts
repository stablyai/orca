import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { registerBoundPty } from '../../../../bind-first-pane.test-fixture'
import {
  createRuntime,
  PANE_KEY,
  TAB_ID,
  LEAF_ID,
  TERMINAL_HANDLE,
  WORKTREE_ID
} from '../../../../orchestration-mailbox-notification-test-harness'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  WORKER_PANE,
  type SessionCallerHarness
} from '../../../orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const COORD_PANE = 'tab_coord:12121212-1212-4212-8212-121212121212'

describe('run-use against a Run whose coordinator is still running', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  const as = (sessionId: string | undefined, method: string, params: Record<string, unknown>) =>
    h.dispatch(orchestrationRequest(method, params, { sessionId }))
  async function chatRun(): Promise<string> {
    return idOf(resultOf(await as(SESSION_X, 'orchestration.runCreate', { objective: 'o' })).run)
  }

  it('refuses a second chat until it passes --takeover, then fences the first', async () => {
    const runId = await chatRun()
    const before = h.db.getRunRaw(runId)

    const refused = await as(SESSION_Y, 'orchestration.runUse', { id: runId })
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'run_coordinator_live', data: { effectsApplied: false } }
    })
    expect(JSON.stringify(refused)).toMatch(
      /the chat in tree-x \(orca_session_id:[^)]+\), which is still open/
    )
    expect(h.db.getRunRaw(runId)).toEqual(before)

    resultOf(await as(SESSION_Y, 'orchestration.runUse', { id: runId, takeover: true }))
    expect(await as(SESSION_X, 'orchestration.check', { run: runId })).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
  })

  it.each([4, 40])(
    'labels a live terminal without inspecting output among %i workspaces',
    async (count) => {
      const { runtime } = createRuntime(h.db, { checkHookAgentPresence: async () => 'live' })
      for (let index = 0; index < count; index++) {
        registerBoundPty(runtime, `pty_${index}`, `repo::/work/other_${index}`, null, {
          tabId: `tab_${index}`,
          leafId: `leaf_${index}`
        })
      }
      const getPane = runtime.getTerminalPaneKey.bind(runtime)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === WORKER_HANDLE ? 'tab_caller:caller' : getPane(handle)
      )
      const metadata = vi.spyOn(runtime, 'getTerminalWorktreeIdForPaneKey')
      const show = vi.spyOn(runtime, 'showTerminal')
      const run = h.db.createRun({
        objective: 'live',
        coordinatorHandle: TERMINAL_HANDLE,
        coordinatorPaneKey: PANE_KEY
      })
      const before = h.db.getRunRaw(run.id)
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      expect(runtime.getTerminalWorktreeIdForPaneKey(`${TAB_ID}:${LEAF_ID}`)).toBe(WORKTREE_ID)
      metadata.mockClear()
      const refused = await dispatcher.dispatch(
        orchestrationRequest('orchestration.runUse', { id: run.id, from: WORKER_HANDLE })
      )
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: 'run_coordinator_live',
          message: expect.stringContaining(
            `the terminal in mailbox (${TERMINAL_HANDLE}), which is still open.`
          ),
          data: { effectsApplied: false }
        }
      })
      expect(metadata).toHaveBeenCalledTimes(1)
      expect(show).not.toHaveBeenCalled()
      expect(h.db.getRunRaw(run.id)).toEqual(before)
    }
  )

  it.each([
    ['its chat was closed', 'closed'],
    ['its terminal agent exited', 'exited'],
    ['no hook identifies its terminal agent', null]
  ] as const)('hands the Run over without a flag when %s', async (_label, state) => {
    let runId: string
    if (state === 'closed') {
      runId = await chatRun()
      hostRef.current = {
        deps: {
          store: {
            getRecord: (id: string) => h.records.get(id) ?? null,
            listRecords: () => [...h.records.values()],
            getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SESSION_Y] })
          }
        }
      }
    } else {
      runId = h.db.createRun({
        objective: 'o',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: COORD_PANE
      }).id
      vi.spyOn(h.runtime, 'coordinatorAgentPresence').mockResolvedValue(state)
    }

    resultOf(await as(SESSION_Y, 'orchestration.runUse', { id: runId }))
    expect(h.db.getRunRaw(runId)?.coordinator_orca_session_id).toBe(SESSION_Y)
  })

  it('requires a hand-over for a foreign Run regardless of coordinator presence', async () => {
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_previous' ? COORD_PANE : handle === WORKER_HANDLE ? WORKER_PANE : null
    )
    vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => {
      const paneKey = handle === 'term_previous' ? COORD_PANE : WORKER_PANE
      if (handle !== 'term_previous' && handle !== WORKER_HANDLE) {
        return null
      }
      return {
        runtimeId: 'runtime',
        terminalHandle: handle,
        ptyId: 'pty',
        worktreeId: 'folder',
        paneKey,
        processIncarnation: handle === 'term_previous' ? 'previous-process' : 'worker-process',
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      }
    })
    const stranger = h.db.createRun({
      objective: 'predecessor sub-Run',
      coordinatorHandle: 'term_previous',
      coordinatorPaneKey: COORD_PANE,
      processIncarnation: 'previous-process'
    })
    const presence = vi.spyOn(h.runtime, 'coordinatorAgentPresence').mockResolvedValue('live')
    const home = h.db.createRun({
      objective: 'home',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const task = h.db.createTask({ spec: 'w', runId: home.id })
    createRootDispatch(h.db, task.id, WORKER_HANDLE, WORKER_PANE, undefined, 'worker-process')
    const runUse = (id: string, takeover: boolean) =>
      as(undefined, 'orchestration.runUse', { id, from: WORKER_HANDLE, takeover })
    const sub = idOf(
      resultOf(
        await as(undefined, 'orchestration.runCreate', { objective: 's', from: WORKER_HANDLE })
      ).run
    )
    resultOf(
      await as(undefined, 'orchestration.runCreate', { objective: 's2', from: WORKER_HANDLE })
    )

    expect(await runUse(home.id, false)).toMatchObject({
      ok: false,
      error: { code: 'worker_cannot_coordinate_own_run' }
    })
    expect(await runUse(stranger.id, true)).toMatchObject({
      ok: false,
      error: { code: 'worker_cannot_take_over_run' }
    })
    const foreignRead = await as(undefined, 'orchestration.check', {
      run: stranger.id,
      terminal: WORKER_HANDLE,
      peek: true
    })
    expect(foreignRead).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(JSON.stringify(foreignRead)).not.toContain('run-use')
    const before = h.db.getRunRaw(stranger.id)
    for (const state of ['live', 'exited', 'unverifiable', null] as const) {
      presence.mockResolvedValue(state)
      const refused = await runUse(stranger.id, false)
      expect(refused).toMatchObject({
        ok: false,
        error: { code: 'run_ownership_required', data: { effectsApplied: false } }
      })
      expect(h.db.getRunRaw(stranger.id)).toEqual(before)
    }
    resultOf(
      await as(undefined, 'orchestration.runHandover', {
        id: stranger.id,
        from: 'term_previous',
        toTask: task.id
      })
    )
    presence.mockResolvedValue('live')
    resultOf(await runUse(stranger.id, false))
    expect(await runUse(sub, true)).toMatchObject({
      error: { code: 'worker_cannot_take_over_run' }
    })
    resultOf(await runUse(sub, false))
    resultOf(await runUse(sub, true))
  })

  it('re-probes when the binding moves under it, then refuses rather than bind blindly', async () => {
    const runId = h.db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
    }).id
    let racers = 0
    const probe = vi.spyOn(h.runtime, 'coordinatorAgentPresence').mockImplementation(async () => {
      racers += 1
      h.db.bindRun({
        runId,
        coordinatorHandle: `term_racer${racers}`,
        coordinatorPaneKey: `tab_r:0000000${racers}-0000-4000-8000-000000000000`
      })
      return 'exited'
    })

    expect(await as(SESSION_Y, 'orchestration.runUse', { id: runId })).toMatchObject({
      ok: false,
      error: {
        code: 'run_binding_changed',
        data: { effectsApplied: false, retryable: true, runId }
      }
    })
    expect(probe).toHaveBeenCalledTimes(3)
    expect(h.db.getRunRaw(runId)?.coordinator_handle).toBe('term_racer3')
  })
})
