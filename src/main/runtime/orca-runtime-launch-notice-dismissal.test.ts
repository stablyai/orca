import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState, TerminalTab, TerminalLayoutSnapshot } from '../../shared/types'
import type { PersistedLaunchNoticeState } from '../../shared/agent-launch-contract'

const WORKTREE_ID = 'wt-notice'
const TAB_ID = 'tab-notice'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'launch-token-1'

function noticeState(): PersistedLaunchNoticeState {
  return {
    launchToken: TOKEN,
    notices: [
      { code: 'disabled_custom_fallback', label: 'My Claude', baseAgent: 'claude' },
      { code: 'env_withheld', label: 'My Claude' }
    ]
  }
}

function makeSession(launchNotices: PersistedLaunchNoticeState | undefined): WorkspaceSessionState {
  const layout: TerminalLayoutSnapshot = {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: 'pty-notice' }
  }
  const tab: TerminalTab = {
    id: TAB_ID,
    ptyId: 'pty-notice',
    worktreeId: WORKTREE_ID,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(launchNotices ? { launchNotices } : {})
  }
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    terminalLayoutsByTabId: { [TAB_ID]: layout }
  }
}

function makeRuntime(initial: WorkspaceSessionState): {
  runtime: OrcaRuntimeService
  setWorkspaceSession: ReturnType<typeof vi.fn>
  getSession: () => WorkspaceSessionState
} {
  let session = initial
  const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    session = next
  })
  const store = {
    getWorkspaceSession: () => session,
    setWorkspaceSession,
    getSettings: () => ({}) as never,
    // No test selector is a registered repo id; the selector guard probes this.
    getRepo: () => undefined
  }
  return {
    runtime: new OrcaRuntimeService(store as never),
    setWorkspaceSession,
    getSession: () => session
  }
}

function launchNoticesOf(session: WorkspaceSessionState): PersistedLaunchNoticeState | undefined {
  return session.tabsByWorktree[WORKTREE_ID][0].launchNotices
}

describe('OrcaRuntimeService.dismissLaunchNotice', () => {
  it('removes the matching code, persists once, and keeps other codes', async () => {
    const { runtime, setWorkspaceSession, getSession } = makeRuntime(makeSession(noticeState()))

    const result = await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'disabled_custom_fallback'
    })

    expect(result).toEqual({ ok: true, changed: true })
    expect(setWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(launchNoticesOf(getSession())).toEqual({
      launchToken: TOKEN,
      notices: [{ code: 'env_withheld', label: 'My Claude' }]
    })
  })

  it('drops launchNotices entirely once the last code is dismissed', async () => {
    const { runtime, getSession } = makeRuntime(
      makeSession({ launchToken: TOKEN, notices: [{ code: 'env_withheld', label: 'My Claude' }] })
    )

    const result = await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'env_withheld'
    })

    expect(result).toEqual({ ok: true, changed: true })
    expect(launchNoticesOf(getSession())).toBeUndefined()
  })

  it('is idempotent on repeat: no second write when the code is already gone', async () => {
    const { runtime, setWorkspaceSession } = makeRuntime(makeSession(noticeState()))

    await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'disabled_custom_fallback'
    })
    setWorkspaceSession.mockClear()

    const second = await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'disabled_custom_fallback'
    })

    expect(second).toEqual({ ok: true, changed: false })
    expect(setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('clears the live pty record too, so a republish cannot resurrect the notice (L4-m7)', async () => {
    const { runtime } = makeRuntime(makeSession(noticeState()))
    const internals = runtime as unknown as {
      ptysById: Map<
        string,
        { worktreeId: string; launchNotices: PersistedLaunchNoticeState | null }
      >
    }
    const pty = { worktreeId: WORKTREE_ID, launchNotices: noticeState() }
    internals.ptysById.set('pty-notice', pty)

    await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'disabled_custom_fallback'
    })
    expect(pty.launchNotices?.notices).toEqual([{ code: 'env_withheld', label: 'My Claude' }])

    await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'env_withheld'
    })
    expect(pty.launchNotices).toBeNull()
  })

  it('dismisses a pty-record-only notice (host-spawned background terminal) (L4-m7)', async () => {
    // No session tab carries the notice — only the live pty record does, as for
    // a host-spawned background terminal. Dismissal must still succeed.
    const { runtime, setWorkspaceSession } = makeRuntime(makeSession(undefined))
    const internals = runtime as unknown as {
      ptysById: Map<
        string,
        { worktreeId: string; launchNotices: PersistedLaunchNoticeState | null }
      >
    }
    const pty = { worktreeId: WORKTREE_ID, launchNotices: noticeState() }
    internals.ptysById.set('pty-notice', pty)

    const result = await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'disabled_custom_fallback'
    })
    expect(result).toEqual({ ok: true, changed: true })
    expect(pty.launchNotices?.notices).toEqual([{ code: 'env_withheld', label: 'My Claude' }])
    // The session tab never carried the notice, so no session write happens.
    expect(setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('fails closed on a foreign token without mutating', async () => {
    const { runtime, setWorkspaceSession, getSession } = makeRuntime(makeSession(noticeState()))

    const result = await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: 'not-the-token',
      code: 'disabled_custom_fallback'
    })

    expect(result).toEqual({ ok: false, changed: false })
    expect(setWorkspaceSession).not.toHaveBeenCalled()
    expect(launchNoticesOf(getSession())?.notices).toHaveLength(2)
  })

  it('surfaces notices to the mobile snapshot and a connected client observes the dismissal once', async () => {
    const { runtime } = makeRuntime(makeSession(noticeState()))

    const initial = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const seededTab = initial.tabs.find((tab) => tab.type === 'terminal')
    expect(seededTab && 'launchNotices' in seededTab ? seededTab.launchNotices : undefined).toEqual(
      noticeState()
    )

    const observed: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((result) => {
      const tab = result.tabs.find((candidate) => candidate.type === 'terminal')
      const notices =
        tab && 'launchNotices' in tab
          ? (tab.launchNotices as PersistedLaunchNoticeState)
          : undefined
      observed.push(notices?.notices.length ?? 0)
    })

    await runtime.dismissLaunchNotice(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      launchToken: TOKEN,
      code: 'disabled_custom_fallback'
    })
    unsubscribe()

    expect(observed).toEqual([1])
  })
})
