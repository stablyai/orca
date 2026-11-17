import { RpcDispatcher } from '../../rpc/dispatcher'
import { TERMINAL_LIFECYCLE_METHODS } from '../../rpc/methods/terminal/terminal-lifecycle-methods'
import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { beginStoppedTerminalTabClose } from './stopped-terminal-tab-close-pending'
import {
  LEAF_A,
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../../terminal/layout/main-owned-workspace-runtime-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const options = {
  reason: 'user' as const,
  requireStoppedTerminalTab: true,
  localPtyTeardownOwnedExternally: true
}

function recordUnboundPty(runtime: Awaited<ReturnType<typeof setupMainOwnedWorkspace>>['runtime']) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercise the state between PTY registration and the saved pane bind.
  const internals = runtime as unknown as {
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state: { connected: boolean; registeredPaneKey: string }
    ) => void
  }
  internals.recordPtyWorktree('pty-unbound', WORKTREE_ID, {
    connected: true,
    registeredPaneKey: `${TAB_ID}:${LEAF_A}`
  })
}

describe('close a stopped terminal tab by id', () => {
  it('removes the persisted stopped tab without a runtime handle', async () => {
    const f = await setupMainOwnedWorkspace({ stopped: true })
    const listed = await f.runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect([...listed.terminals, ...(listed.tabs ?? [])].map((tab) => tab.tabId)).toContain('tab-1')
    await f.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, options)
    expect(f.session().tabsByWorktree['repo-1::/workspace']).toEqual([])
    expect(f.stopped).toEqual([])
  })

  it('refuses a PTY bound while the tab close waits to commit', async () => {
    const f = await setupMainOwnedWorkspace({ stopped: true })
    const apply = f.runtime.applyLayoutCommand.bind(f.runtime)
    vi.spyOn(f.runtime, 'applyLayoutCommand').mockImplementation(async (command, run) => {
      if (command.type === 'closeTabs') {
        await expect(
          f.runtime.ensureRestoredPaneStarted({
            worktreeId: WORKTREE_ID,
            tabId: TAB_ID,
            leafId: LEAF_A
          })
        ).rejects.toThrow('Terminal tab is closing.')
        f.runtime.registerPty('pty-race', WORKTREE_ID, null)
        f.session().terminalLayoutsByTabId[TAB_ID]!.ptyIdsByLeafId = { [LEAF_A]: 'pty-race' }
      }
      return apply(command, run)
    })
    await expect(
      f.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, options)
    ).rejects.toMatchObject({
      code: 'terminal_tab_live'
    })
    expect(f.session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([TAB_ID])
  })

  it('refuses an unbound runtime PTY registered before the close commits', async () => {
    const f = await setupMainOwnedWorkspace({ stopped: true })
    const apply = f.runtime.applyLayoutCommand.bind(f.runtime)
    vi.spyOn(f.runtime, 'applyLayoutCommand').mockImplementation(async (command, run) => {
      if (command.type === 'closeTabs') {
        recordUnboundPty(f.runtime)
      }
      return apply(command, run)
    })

    await expect(
      f.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, options)
    ).rejects.toMatchObject({ code: 'terminal_tab_live' })
    expect(f.session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(f.session().terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({})
  })

  it('stops an unbound runtime PTY when a regular tab close commits', async () => {
    const f = await setupMainOwnedWorkspace({ stopped: true })
    const apply = f.runtime.applyLayoutCommand.bind(f.runtime)
    vi.spyOn(f.runtime, 'applyLayoutCommand').mockImplementation(async (command, run) => {
      if (command.type === 'closeTabs') {
        recordUnboundPty(f.runtime)
      }
      return apply(command, run)
    })

    await f.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, { reason: 'user' })
    expect(f.session().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(f.stopped).toContain('pty-unbound')
  })

  it('continues starting WSL panes after a closing tab rejects', async () => {
    const f = await setupMainOwnedWorkspace({ stopped: true })
    const release = beginStoppedTerminalTabClose(f.runtime, WORKTREE_ID, TAB_ID)
    const other = { worktreeId: WORKTREE_ID, tabId: 'other-tab', leafId: LEAF_A }
    const original = f.runtime.ensureRestoredPaneStarted.bind(f.runtime)
    const start = vi
      .spyOn(f.runtime, 'ensureRestoredPaneStarted')
      .mockImplementation((pane) =>
        pane.tabId === TAB_ID ? original(pane) : Promise.resolve({ id: 'other-pty' })
      )
    try {
      await expect(
        f.runtime.startWslHeldTerminalPanes([
          { worktreeId: WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_A },
          other
        ])
      ).resolves.toEqual({ started: false })
      expect(start).toHaveBeenCalledWith(other, { wslUserAct: true })
    } finally {
      release()
    }
  })

  it('continues resuming slept panes after a closing tab rejects', async () => {
    const f = await setupMainOwnedWorkspace({ stopped: true })
    const other = { worktreeId: WORKTREE_ID, tabId: 'other-tab', leafId: LEAF_A }
    const record = (tabId: string): SleepingAgentSessionRecord => ({
      paneKey: `${tabId}:${LEAF_A}`,
      tabId,
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      providerSession: { key: 'session_id', id: `${tabId}-session` },
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    })
    f.session().sleepingAgentSessionsByPaneKey = {
      [`${TAB_ID}:${LEAF_A}`]: record(TAB_ID),
      [`${other.tabId}:${LEAF_A}`]: record(other.tabId)
    }
    const release = beginStoppedTerminalTabClose(f.runtime, WORKTREE_ID, TAB_ID)
    const original = f.runtime.ensureRestoredPaneStarted.bind(f.runtime)
    const start = vi
      .spyOn(f.runtime, 'ensureRestoredPaneStarted')
      .mockImplementation((pane) =>
        pane.tabId === TAB_ID ? original(pane) : Promise.resolve({ id: 'other-pty' })
      )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(f.runtime.resumeSleptWorkspaceAgents(WORKTREE_ID)).resolves.toBeUndefined()
      expect(start).toHaveBeenCalledWith(other)
    } finally {
      warn.mockRestore()
      release()
    }
  })

  it.each([
    ['missing', 'terminal_tab_not_found'],
    ['live', 'terminal_tab_live'],
    ['unknown', 'terminal_stop_unverifiable']
  ])('preserves the %s refusal across RPC', async (state, code) => {
    const f = await setupMainOwnedWorkspace({ stopped: state !== 'live' })
    if (state === 'unknown') {
      f.session().remoteSessionIdsByTabId = { [TAB_ID]: 'unverified-saved-pty' }
    }
    const dispatcher = new RpcDispatcher({
      runtime: f.runtime,
      methods: TERMINAL_LIFECYCLE_METHODS
    })
    const reply = await dispatcher.dispatch({
      id: 'close-stopped',
      authToken: 'unused',
      method: 'terminal.closeTabById',
      params: { worktree: `id:${WORKTREE_ID}`, tabId: state === 'missing' ? 'absent' : TAB_ID }
    })
    expect(reply).toMatchObject({ ok: false, error: { code } })
    if (state === 'live') {
      expect(reply).toMatchObject({
        error: { data: { nextStep: 'Use orca terminal close --terminal <handle> --tab.' } }
      })
    }
    expect(f.session().tabsByWorktree['repo-1::/workspace']?.map((tab) => tab.id)).toEqual([
      'tab-1'
    ])
    expect(f.stopped).toEqual([])
  })
})
