// Layout-owner build: a client's startPane and wake start the pane through main's one starter
// after the command is written. The reply never carries the effects, a wake keeps the pane's
// resume record in the pane-owned form, and a failed start shows on the pane and keeps the record.
import { describe, expect, it, vi } from 'vitest'
import {
  isPaneSleepRecord,
  type SleepingAgentSessionRecord as SleepingRecord
} from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-session-contracts'
import type { RestoredPaneTrigger } from './terminal/recovery/restored-pane-start'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, electronMocks } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

class StatusRuntime extends OrcaRuntimeService {
  /** The start's terminal is gone once its create returns, as one that exits before main can bind it. */
  startsNoTerminal = false
  protected override materializePendingMobileSessionTerminal(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    trigger: RestoredPaneTrigger & { sessionId?: string }
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return super
      .materializePendingMobileSessionTerminal(worktreeId, tab, trigger)
      .then((created) => {
        if (this.startsNoTerminal && created.tab.ptyId) {
          this.ptysById.delete(created.tab.ptyId)
        }
        return created
      })
  }
  setStartStatus(paneKey: string, status: 'sleeping'): void {
    this.paneStartStatuses?.set(paneKey, { status })
  }
  startStatusOf(paneKey: string) {
    return this.paneStartStatuses?.peek(paneKey) ?? null
  }
  loseContactWith(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.connected = false
    }
    this.markPtyLivenessUnverifiable(ptyId, 'host out of contact')
  }
}

// A running agent's workspace sleep, which the window's wake relaunched before C1c.
const RECORD: SleepingRecord = {
  paneKey: PANE_KEY,
  tabId: 'host-tab',
  worktreeId: TEST_WORKTREE_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'provider-session-1' },
  prompt: 'do the thing',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep'
}

async function desktopRuntime(
  opts: {
    slept?: boolean
    session?: ReturnType<typeof makeWorkspaceSessionWithHeadlessTerminal>
    /** False: the window's graph has not listed the workspace's tabs yet, as at a relaunch. */
    activate?: boolean
  } = {}
) {
  const session =
    opts.session ??
    makeWorkspaceSessionWithHeadlessTerminal(
      opts.slept ? { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: RECORD } } : {}
    )
  // The tab was launched as the agent its record resumes.
  session.tabsByWorktree[TEST_WORKTREE_ID]![0]!.launchAgent = 'claude'
  const fixture = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new StatusRuntime(fixture.runtimeStore as never, undefined, {
    getDesktopWindowStatus: () => 'openable'
  })
  const started = deferred<{ id: string }>()
  const spawn = vi.fn((_args: { command?: string; sessionId?: string }) => started.promise)
  const kill = vi.fn(() => true)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  // The desktop window is open: before C1c it started this pane itself.
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only isDestroyed from the window mock.
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
  if (opts.activate !== false) {
    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'runtime'
    })
  }
  return {
    runtime,
    spawn,
    kill,
    started,
    getSession: fixture.getSession,
    setSession: fixture.setSession
  }
}

const startPane = { type: 'startPane', workspace: TEST_WORKTREE_ID, tabId: 'host-tab' } as const
const wake = { type: 'wake', workspace: TEST_WORKTREE_ID, tabId: 'host-tab' } as const

describe('a client’s startPane in the layout-owner build', () => {
  it('starts a pane restoring from its terminal once, through main, and replies without effects', async () => {
    const { runtime, spawn, started } = await desktopRuntime()
    runtime.setStartStatus(PANE_KEY, 'sleeping')

    const reply = await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    // The command's start is under way before any other trigger; a CLI send joins it.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    started.resolve({ id: 'persisted-pty' })

    await expect(cliSend).resolves.toMatchObject({ id: 'persisted-pty' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'persisted-pty' }))
    // The wire reply is the command's outcome and stream position, byte for byte.
    expect(JSON.stringify(reply)).toBe(
      JSON.stringify({ ok: true, result: {}, frameSeq: reply.frameSeq })
    )
  })

  it('leaves a pane whose terminal is live alone', async () => {
    const { runtime, spawn, started } = await desktopRuntime()
    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    await vi.waitFor(() => expect(runtime.startStatusOf(PANE_KEY)).toBeNull())

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('leaves a pane alone while its terminal is out of contact', async () => {
    const { runtime, spawn, started } = await desktopRuntime()
    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    await vi.waitFor(() => expect(runtime.startStatusOf(PANE_KEY)).toBeNull())

    // Lost contact is never evidence the terminal ended.
    runtime.loseContactWith('persisted-pty')
    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('starts a pane the window views before its graph lists the tab', async () => {
    const { runtime, spawn, started } = await desktopRuntime({ activate: false })
    runtime.setStartStatus(PANE_KEY, 'sleeping')

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'persisted-pty' })

    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    expect(runtime.startStatusOf(PANE_KEY)).not.toMatchObject({ status: 'failed' })
  })

  it('replaces the empty shell a hibernated agent left and resumes the agent', async () => {
    const { runtime, spawn, kill, started, getSession, setSession } = await desktopRuntime()
    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    await vi.waitFor(() => expect(runtime.startStatusOf(PANE_KEY)).toBeNull())
    // The agent hibernated: its record says done, and its shell has printed nothing since.
    setSession({
      ...getSession(),
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: { ...RECORD, state: 'done' } }
    })
    spawn.mockClear()
    spawn.mockResolvedValue({ id: 'resumed-pty' })

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(kill).toHaveBeenCalledWith('persisted-pty')
    expect(spawn.mock.calls[0]?.[0].command).toContain('provider-session-1')
  })

  it('keeps the pane on its terminal and starts nothing when that terminal would not stop', async () => {
    const { runtime, spawn, kill, started, getSession, setSession } = await desktopRuntime()
    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    await vi.waitFor(() => expect(runtime.startStatusOf(PANE_KEY)).toBeNull())
    setSession({
      ...getSession(),
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: { ...RECORD, state: 'done' } }
    })
    spawn.mockClear()
    kill.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(kill).toHaveBeenCalledWith('persisted-pty')
    expect(reply).toMatchObject({ ok: false })
    expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('resumes the agent a pre-stable-id build recorded under the pane’s number', async () => {
    const legacyKey = 'host-tab:2'
    const { runtime, spawn, started } = await desktopRuntime({
      session: makeWorkspaceSessionWithHeadlessTerminal({
        sleepingAgentSessionsByPaneKey: {
          [legacyKey]: { ...RECORD, paneKey: legacyKey },
          // A second alias of the same conversation is the same record, not another pane's.
          'host-tab:3': { ...RECORD, paneKey: 'host-tab:3', capturedAt: 2 }
        }
      })
    })
    runtime.setStartStatus(PANE_KEY, 'sleeping')

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'persisted-pty' })

    expect(spawn.mock.calls[0]?.[0].command).toContain('provider-session-1')
  })

  it('shows the pane starting in the frame its reply names', async () => {
    const { runtime } = await desktopRuntime()

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    expect(runtime.startStatusOf(PANE_KEY)).toEqual({ status: 'starting' })
  })

  it('shows a failed start on the pane', async () => {
    const { runtime, started } = await desktopRuntime()
    runtime.setStartStatus(PANE_KEY, 'sleeping')

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.reject(new Error('spawn exploded'))

    await vi.waitFor(() =>
      expect(runtime.startStatusOf(PANE_KEY)).toMatchObject({ status: 'failed' })
    )
  })
  // The window shows this reason through its wait for main's start.
  it('shows terminal_not_started when the terminal ends before main can bind it', async () => {
    const { runtime, started } = await desktopRuntime()
    runtime.setStartStatus(PANE_KEY, 'sleeping')
    runtime.startsNoTerminal = true

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.resolve({ id: 'persisted-pty' })

    await vi.waitFor(() =>
      expect(runtime.startStatusOf(PANE_KEY)).toEqual({
        status: 'failed',
        reason: 'terminal_not_started'
      })
    )
  })
})

describe('a client’s wake of a slept pane in the layout-owner build', () => {
  it('resumes its agent through main and keeps the record pane-owned, so a host crash resumes again', async () => {
    const { runtime, spawn, started, getSession } = await desktopRuntime({ slept: true })

    const reply = await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    expect(reply).toMatchObject({ ok: true, result: { woken: [PANE_KEY] } })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    const command = spawn.mock.calls[0]![0].command ?? ''
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      state: 'done',
      restoreOnTabOpenOnly: true
    })

    // The host crashes: its terminal is gone, and a new runtime loads the same profile.
    const crashed = getSession()
    const restarted = await desktopRuntime({ session: crashed })
    restarted.runtime.setStartStatus(PANE_KEY, 'sleeping')
    await restarted.runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await vi.waitFor(() => expect(restarted.spawn).toHaveBeenCalled())
    expect(restarted.spawn.mock.calls[0]![0].command ?? '').toContain('provider-session-1')
  })

  it('a woken running pane reads live, not sleeping: its record becomes a running agent’s', async () => {
    const { runtime, spawn, started, getSession } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() =>
      expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.origin).toBe('live')
    )
    const record = getSession().sleepingAgentSessionsByPaneKey![PANE_KEY]!
    // Not a sleep record, so main's layout holds it as the pane's resume record (L254).
    expect(isPaneSleepRecord(record)).toBe(false)
    expect(record.providerSession).toEqual(RECORD.providerSession)
    expect(runtime.startStatusOf(PANE_KEY)).toBeNull()
  })

  it('keeps the record when the start fails', async () => {
    const { runtime, spawn, started, getSession } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.reject(new Error('spawn exploded'))

    await vi.waitFor(() =>
      expect(runtime.startStatusOf(PANE_KEY)).toMatchObject({ status: 'failed' })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
  })

  it('starts once for a second wake while the first is starting', async () => {
    const { runtime, spawn, started } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    started.resolve({ id: 'persisted-pty' })

    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('starts nothing for a record-only wake', async () => {
    const { runtime, spawn, getSession } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY], recordOnly: true })
    await Promise.resolve()

    expect(spawn).not.toHaveBeenCalled()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })
})
