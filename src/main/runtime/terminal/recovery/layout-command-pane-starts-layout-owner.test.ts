// Main starts panes after layout commit; replies contain no effects and failed starts retain resume records.
import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord as SleepingRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-session-contracts'
import type { RestoredPaneTrigger } from './restored-pane-start'
import { BareWorkspaceTerminalLaunchError } from '../../../workspaces/catalog/workspace-git-storage'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const { electronMocks } = await import('../../orca-runtime-test-mocks/setup.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

class StatusRuntime extends OrcaRuntimeService {
  startsNoTerminal = false
  bareStorage = false
  protected override async workspaceUsesBareGitStorage(): Promise<boolean> {
    return this.bareStorage
  }
  protected override materializePendingMobileSessionTerminal(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    trigger: RestoredPaneTrigger & { sessionId?: string }
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return super
      .materializePendingMobileSessionTerminal(worktreeId, tab, trigger)
      .then((created) => {
        if (this.startsNoTerminal && created.tab.ptyId) {
          this.terminalIdentity.removePty(created.tab.ptyId)
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
      this.terminalIdentity.setPtyConnected(pty, false)
    }
    this.markPtyLivenessUnverifiable(ptyId, 'host out of contact')
  }
}

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
    activate?: boolean
  } = {}
) {
  const session =
    opts.session ??
    makeWorkspaceSessionWithHeadlessTerminal(
      opts.slept ? { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: RECORD } } : {}
    )
  session.tabsByWorktree[TEST_WORKTREE_ID]![0]!.launchAgent = 'claude'
  const fixture = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new StatusRuntime(fixture.runtimeStore, undefined, {
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
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
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
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    started.resolve({ id: 'persisted-pty' })

    await expect(cliSend).resolves.toMatchObject({ id: 'persisted-pty' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'persisted-pty' }))
    expect(JSON.stringify(reply)).toBe(
      JSON.stringify({ ok: true, result: {}, frameSeq: reply.frameSeq })
    )
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
})

it('refuses a bare replacement before stopping or clearing the saved live owner', async () => {
  const { runtime, spawn, kill, started, getSession } = await desktopRuntime()
  await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
  started.resolve({ id: 'persisted-pty' })
  await vi.waitFor(() => expect(runtime.startStatusOf(PANE_KEY)).toBeNull())
  runtime.bareStorage = true
  spawn.mockClear()
  await expect(
    runtime.applyLayoutCommand({
      type: 'restartPane',
      workspace: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      paneKey: PANE_KEY
    })
  ).rejects.toBeInstanceOf(BareWorkspaceTerminalLaunchError)
  expect(kill).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  expect(getSession().terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[HEADLESS_LEAF_ID]).toBe(
    'persisted-pty'
  )
})

it('applies the same fresh admission before a completed-record Start retires its live binding', async () => {
  const { runtime, spawn, kill, started, getSession, setSession } = await desktopRuntime()
  await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
  started.resolve({ id: 'persisted-pty' })
  await vi.waitFor(() => expect(runtime.startStatusOf(PANE_KEY)).toBeNull())
  setSession({
    ...getSession(),
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: { ...RECORD, state: 'done' } }
  })
  runtime.bareStorage = true
  spawn.mockClear()
  await expect(
    runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
  ).rejects.toBeInstanceOf(BareWorkspaceTerminalLaunchError)
  expect(kill).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true)
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

    const crashed = getSession()
    const restarted = await desktopRuntime({ session: crashed })
    restarted.runtime.setStartStatus(PANE_KEY, 'sleeping')
    await restarted.runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await vi.waitFor(() => expect(restarted.spawn).toHaveBeenCalled())
    expect(restarted.spawn.mock.calls[0]![0].command ?? '').toContain('provider-session-1')
  })
})
