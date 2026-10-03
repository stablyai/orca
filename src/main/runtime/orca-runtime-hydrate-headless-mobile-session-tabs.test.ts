import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import * as terminalProjection from './mobile-session-terminal-projection'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo::/workspace'
const CHAT = 'agent-session:chat'

type RuntimeInternals = {
  getAvailableAuthoritativeWindow(): unknown
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  buildHeadlessMobileSessionBrowserTabs: () => RuntimeMobileSessionSnapshotTab[]
  reconcileHeadlessMobileSessionBrowserTabs: () => void
  hasServeOrSshOwnedBinding(tab: { ptyId?: string }): boolean
  hasRecentExpiredSshLeasePane(): boolean
  isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean
  shouldPreserveHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId: string,
    options: {
      allowAttachedWindow: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      force?: boolean
    }
  ): Set<string>
}

function browserTab(): RuntimeMobileSessionSnapshotTab {
  return {
    type: 'browser',
    id: 'browser',
    browserWorkspaceId: 'page',
    browserPageId: 'browser',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    title: 'Page',
    url: 'about:blank',
    isActive: false
  }
}

function setup() {
  const runtime = new OrcaRuntimeService() as unknown as RuntimeInternals
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: ['first', 'second'].map((id, sortOrder) => ({
        id,
        worktreeId: WORKTREE,
        ptyId: `renderer-${id}`,
        title: id,
        customTitle: null,
        color: null,
        sortOrder,
        createdAt: 1
      }))
    },
    activeTabIdByWorktree: { [WORKTREE]: 'first' }
  }
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: WORKTREE,
    publicationEpoch: 'structured:restore',
    snapshotVersion: 1,
    activeGroupId: 'chat-group',
    activeTabId: CHAT,
    activeTabType: 'agent-session',
    tabGroups: [{ id: 'chat-group', activeTabId: CHAT, tabOrder: [CHAT] }],
    tabs: [
      {
        type: 'agent-session',
        id: CHAT,
        sessionId: 'chat',
        agent: 'codex',
        title: 'Chat',
        isActive: true
      }
    ]
  }
  runtime.getAvailableAuthoritativeWindow = () => ({ id: 1 })
  runtime.getWorkspaceSessionForWorktree = () => session
  runtime.buildHeadlessMobileSessionBrowserTabs = vi.fn(() => [])
  runtime.reconcileHeadlessMobileSessionBrowserTabs = vi.fn()
  runtime.hasServeOrSshOwnedBinding = (tab) => tab.ptyId?.startsWith('serve-') === true
  runtime.hasRecentExpiredSshLeasePane = () => false
  runtime.mobileSessionTabsByWorktree.set(WORKTREE, snapshot)
  const rebuild = vi.spyOn(terminalProjection, 'buildHeadlessMobileSessionTerminalTabs')
  return { runtime, session, snapshot, rebuild }
}

afterEach(() => vi.restoreAllMocks())

describe('persisted terminal hydration behind non-terminal snapshots', () => {
  it.each([false, true])('preserves the active chat and its group (browser split: %s)', (split) => {
    const { runtime, session, snapshot } = setup()
    if (split) {
      const browser = browserTab()
      snapshot.tabs.push(browser)
      // The page is still live, so the rebuild republishes it.
      runtime.buildHeadlessMobileSessionBrowserTabs = vi.fn(() => [browser])
      snapshot.tabGroups!.unshift({
        id: 'browser-group',
        activeTabId: 'browser',
        tabOrder: ['browser']
      })
      snapshot.tabGroupLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.4,
        first: { type: 'leaf', groupId: 'browser-group' },
        second: { type: 'leaf', groupId: 'chat-group' }
      }
      session.tabGroups = {
        [WORKTREE]: snapshot.tabGroups!.map((group) => ({ ...group, worktreeId: WORKTREE }))
      }
      session.tabGroupLayouts = { [WORKTREE]: snapshot.tabGroupLayout }
    }

    const reconciled = runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })
    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!

    expect(
      result.tabs.filter((tab) => tab.type === 'terminal').map((tab) => tab.parentTabId)
    ).toEqual(['first', 'second'])
    expect(result.tabs).toEqual(expect.arrayContaining(snapshot.tabs))
    expect(result.activeTabId).toBe(CHAT)
    expect(result.activeTabType).toBe('agent-session')
    expect(result.activeGroupId).toBe('chat-group')
    expect(result.tabGroups).toContainEqual({
      id: 'chat-group',
      activeTabId: CHAT,
      tabOrder: [CHAT, 'first', 'second']
    })
    expect(result.tabGroupLayout).toEqual(snapshot.tabGroupLayout)
    if (split) {
      expect(result.tabGroups).toContainEqual(snapshot.tabGroups![0])
    }
    expect(reconciled.has(WORKTREE)).toBe(false)
  })

  it('keeps the existing chat groups ahead of a stale persisted split', () => {
    const { runtime, session, snapshot } = setup()
    session.tabGroups = {
      [WORKTREE]: ['left', 'right'].map((id) => ({
        id,
        worktreeId: WORKTREE,
        activeTabId: null,
        tabOrder: []
      }))
    }
    session.tabGroupLayouts = {
      [WORKTREE]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' }
      }
    }
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })
    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.tabGroups).toEqual([
      { ...snapshot.tabGroups![0], tabOrder: [CHAT, 'first', 'second'] }
    ])
    expect(result.tabGroupLayout).toBeUndefined()
  })

  it('only reconciles browsers when terminals already exist', () => {
    const { runtime, snapshot, rebuild } = setup()
    snapshot.tabs.push({
      type: 'terminal',
      id: 'existing::leaf',
      parentTabId: 'existing',
      leafId: 'leaf',
      title: 'Existing',
      isActive: false
    })

    const reconciled = runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    expect(reconciled.has(WORKTREE)).toBe(true)
    expect(rebuild).not.toHaveBeenCalled()
    expect(runtime.buildHeadlessMobileSessionBrowserTabs).not.toHaveBeenCalled()
    expect(runtime.reconcileHeadlessMobileSessionBrowserTabs).toHaveBeenCalledWith(
      WORKTREE,
      snapshot
    )
    expect(runtime.mobileSessionTabsByWorktree.get(WORKTREE)).toBe(snapshot)
  })

  it('still merges runtime-owned terminals and filters attached renderer terminals', () => {
    const { runtime, session, snapshot, rebuild } = setup()
    session.tabsByWorktree[WORKTREE]![1]!.ptyId = 'serve-second'

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true,
      runtimeOwnedTerminalCandidateKnown: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(rebuild).toHaveBeenCalledOnce()
    expect(result.tabs).toEqual([
      snapshot.tabs[0],
      expect.objectContaining({ type: 'terminal', parentTabId: 'second', ptyId: 'serve-second' })
    ])
  })

  it('still replaces existing tabs on a forced rebuild', () => {
    const { runtime } = setup()
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true,
      force: true
    })
    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.tabs.map((tab) => tab.type)).toEqual(['terminal', 'terminal'])
    // Guards the epoch fix below from over-correcting: a plain rebuild that
    // merges into nothing is headless-built and must say so.
    expect(result.publicationEpoch.startsWith('headless-hydrated:')).toBe(true)
  })
})

describe('chat-only fall-through hygiene', () => {
  const RENDERER_EPOCH = 'renderer:6b1f0f5c-0b6a-4d31-9d1f-6a0f1d2c3b4e'

  it('carries a renderer base epoch forward instead of reclassing as headless-built', () => {
    const { runtime, snapshot } = setup()
    snapshot.publicationEpoch = RENDERER_EPOCH

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.publicationEpoch).toBe(RENDERER_EPOCH)
    expect(runtime.isHeadlessBuiltMobileSessionPublicationBase(result.publicationEpoch)).toBe(false)
    const hydrated = result.tabs.find((tab) => tab.type === 'terminal')!
    expect(runtime.shouldPreserveHeadlessMobileSessionTab(result, hydrated)).toBe(false)
  })

  it('keeps a headless base epoch headless-built', () => {
    const { runtime, snapshot } = setup()
    snapshot.publicationEpoch = 'headless:seed'

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.publicationEpoch.startsWith('headless-hydrated:')).toBe(true)
    expect(runtime.isHeadlessBuiltMobileSessionPublicationBase(result.publicationEpoch)).toBe(true)
  })

  it('publishes persisted groups in the wire shape, without worktreeId', () => {
    const { runtime, session, snapshot } = setup()
    delete snapshot.tabGroups
    session.tabGroups = {
      [WORKTREE]: ['left', 'right'].map((id) => ({
        id,
        worktreeId: WORKTREE,
        activeTabId: null,
        tabOrder: [],
        recentTabIds: []
      }))
    }

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.tabGroups!.length).toBeGreaterThan(0)
    for (const group of result.tabGroups!) {
      expect(Object.keys(group)).not.toContain('worktreeId')
    }
  })

  it('drops a browser tab whose page is gone', () => {
    const { runtime, snapshot } = setup()
    snapshot.tabs.push(browserTab())
    snapshot.tabGroups![0]!.tabOrder.push('browser')

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.tabs.map((tab) => tab.id)).not.toContain('browser')
    expect(result.tabs.some((tab) => tab.id === CHAT)).toBe(true)
    expect(result.tabGroups!.flatMap((group) => group.tabOrder)).not.toContain('browser')
  })

  it('keeps a live browser active instead of moving onto a rebuilt terminal', () => {
    const { runtime, snapshot } = setup()
    const browser = { ...browserTab(), isActive: true }
    snapshot.tabs[0]!.isActive = false
    snapshot.tabs.push(browser)
    snapshot.tabGroups!.push({ id: 'browser-group', activeTabId: 'browser', tabOrder: ['browser'] })
    snapshot.activeGroupId = 'browser-group'
    snapshot.activeTabId = 'browser'
    snapshot.activeTabType = 'browser'
    runtime.buildHeadlessMobileSessionBrowserTabs = vi.fn(() => [browser])

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.activeTabId).toBe('browser')
    expect(result.activeTabType).toBe('browser')
    expect(result.activeGroupId).toBe('browser-group')
    expect(
      result.tabGroups!.find((group) => group.id === result.activeGroupId)!.tabOrder
    ).toContain('browser')
  })

  it('seats the active group on a persisted split when nothing was published yet', () => {
    const { runtime, session } = setup()
    runtime.mobileSessionTabsByWorktree.delete(WORKTREE)
    session.tabGroups = {
      [WORKTREE]: [
        { id: 'left', worktreeId: WORKTREE, activeTabId: 'first', tabOrder: ['first'] },
        { id: 'right', worktreeId: WORKTREE, activeTabId: 'second', tabOrder: ['second'] }
      ]
    }

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    const activeTab = result.tabs.find((tab) => tab.id === result.activeTabId)!
    const activeTopLevelId = activeTab.type === 'terminal' ? activeTab.parentTabId : activeTab.id
    expect(result.tabGroups!.map((group) => group.id)).toEqual(['left', 'right'])
    expect(
      result.tabGroups!.find((group) => group.id === result.activeGroupId)?.tabOrder
    ).toContain(activeTopLevelId)
  })

  it('reseats the active group when the stale browser emptied it', () => {
    const { runtime, snapshot } = setup()
    snapshot.tabs.push(browserTab())
    snapshot.tabGroups!.push({ id: 'browser-group', activeTabId: 'browser', tabOrder: ['browser'] })
    snapshot.activeGroupId = 'browser-group'
    snapshot.activeTabId = 'browser'
    snapshot.activeTabType = 'browser'

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.tabGroups!.map((group) => group.id)).not.toContain('browser-group')
    expect(result.tabGroups!.some((group) => group.id === result.activeGroupId)).toBe(true)
    expect(result.tabs.some((tab) => tab.id === result.activeTabId)).toBe(true)
  })
})
