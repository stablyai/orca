/* eslint-disable max-lines */
import { useEffect, useRef } from 'react'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../shared/constants'
import { isGitRepoKind } from '../../shared/repo-kind'

import { Minimize2, PanelLeft, PanelRight } from 'lucide-react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { Toaster } from '@/components/ui/sonner'
import { useAppStore } from './store'
import { useIpcEvents } from './hooks/useIpcEvents'
import Sidebar from './components/Sidebar'
import Terminal from './components/Terminal'
import { shutdownBufferCaptures } from './components/terminal-pane/TerminalPane'
import Landing from './components/Landing'
import Settings from './components/settings/Settings'
import RightSidebar from './components/right-sidebar'
import QuickOpen from './components/QuickOpen'
import { ZoomOverlay } from './components/ZoomOverlay'
import { useGitStatusPolling } from './components/right-sidebar/useGitStatusPolling'
import {
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './runtime/sync-runtime-graph'
import { getVisibleWorktreeIds } from './components/sidebar/visible-worktrees'
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop'
import { registerUpdaterBeforeUnloadBypass } from './lib/updater-beforeunload'
import type { BrowserTab, PersistedOpenFile, WorkspaceVisibleTabType } from '../../shared/types'
import type { OpenFile } from './store/slices/editor'

const isMac = navigator.userAgent.includes('Mac')
const SIDEBAR_TRANSITION_MS = 200

/** Build the editor-file portion of the workspace session for persistence.
 *  Only edit-mode files are saved — diffs and conflict views are transient. */
function buildEditorSessionData(
  openFiles: OpenFile[],
  activeFileIdByWorktree: Record<string, string | null>,
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
): {
  openFilesByWorktree: Record<string, PersistedOpenFile[]>
  activeFileIdByWorktree: Record<string, string | null>
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
} {
  const editFiles = openFiles.filter((f) => f.mode === 'edit')
  const byWorktree: Record<string, PersistedOpenFile[]> = {}
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined
    })
  }
  return {
    openFilesByWorktree: byWorktree,
    activeFileIdByWorktree,
    activeTabTypeByWorktree
  }
}

function buildBrowserSessionData(
  browserTabsByWorktree: Record<string, BrowserTab[]>,
  activeBrowserTabIdByWorktree: Record<string, string | null>
): {
  browserTabsByWorktree: Record<string, BrowserTab[]>
  activeBrowserTabIdByWorktree: Record<string, string | null>
} {
  return {
    // Why: browser tabs persist only lightweight chrome state. Live guest
    // webContents are recreated on restore, so loading is reset to false and
    // transient errors are preserved only as last-known tab metadata.
    browserTabsByWorktree: Object.fromEntries(
      Object.entries(browserTabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.map((tab) => ({ ...tab, loading: false }))
      ])
    ),
    activeBrowserTabIdByWorktree
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm.js focuses a hidden <textarea class="xterm-helper-textarea"> for
  // keyboard input.  That element IS an editable target, but we must NOT
  // suppress global shortcuts when the terminal itself is focused — otherwise
  // Cmd/Ctrl+P and other app-level keybindings become unreachable.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

function App(): React.JSX.Element {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const canExpandPaneByTabId = useAppStore((s) => s.canExpandPaneByTabId)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const fetchRepos = useAppStore((s) => s.fetchRepos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const initGitHubCache = useAppStore((s) => s.initGitHubCache)
  const refreshAllGitHub = useAppStore((s) => s.refreshAllGitHub)
  const hydrateWorkspaceSession = useAppStore((s) => s.hydrateWorkspaceSession)
  const hydrateEditorSession = useAppStore((s) => s.hydrateEditorSession)
  const hydrateBrowserSession = useAppStore((s) => s.hydrateBrowserSession)
  const reconnectPersistedTerminals = useAppStore((s) => s.reconnectPersistedTerminals)
  const hydratePersistedUI = useAppStore((s) => s.hydratePersistedUI)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)

  // Editor state for session persistence
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFileIdByWorktree = useAppStore((s) => s.activeFileIdByWorktree)
  const activeTabTypeByWorktree = useAppStore((s) => s.activeTabTypeByWorktree)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const activeBrowserTabIdByWorktree = useAppStore((s) => s.activeBrowserTabIdByWorktree)

  // Right sidebar + editor state
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const setQuickOpenVisible = useAppStore((s) => s.setQuickOpenVisible)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const hasSeenInitialSidebarStateRef = useRef(false)

  // Subscribe to IPC push events
  useIpcEvents()
  // Why: git conflict-operation state also drives the worktree cards. Polling
  // cannot live under RightSidebar because App unmounts that subtree when the
  // sidebar is closed, which leaves stale "Rebasing"/"Merging" badges behind
  // until some unrelated view remount happens to refresh them.
  useGitStatusPolling()
  useGlobalFileDrop()

  const settings = useAppStore((s) => s.settings)

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false
    // Why: AbortController must be declared outside the async block so the
    // cleanup function can abort it. Under StrictMode the effect runs twice;
    // without this, the first (unmounted) pass would keep spawning PTYs.
    const abortController = new AbortController()

    void (async () => {
      try {
        await fetchRepos()
        await fetchAllWorktrees()
        const persistedUI = await window.api.ui.get()
        const session = await window.api.session.get()
        if (!cancelled) {
          hydratePersistedUI(persistedUI)
          hydrateWorkspaceSession(session)
          hydrateEditorSession(session)
          hydrateBrowserSession(session)
          await reconnectPersistedTerminals(abortController.signal)
          syncZoomCSSVar()
        }
      } catch (error) {
        console.error('Failed to hydrate workspace session:', error)
        if (!cancelled) {
          hydratePersistedUI({
            lastActiveRepoId: null,
            lastActiveWorktreeId: null,
            sidebarWidth: 280,
            rightSidebarWidth: 350,
            groupBy: 'none',
            sortBy: 'name',
            showActiveOnly: false,
            filterRepoIds: [],
            uiZoomLevel: 0,
            editorFontZoomLevel: 0,
            worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
            dismissedUpdateVersion: null,
            lastUpdateCheckAt: null
          })
          hydrateWorkspaceSession({
            activeRepoId: null,
            activeWorktreeId: null,
            activeTabId: null,
            tabsByWorktree: {},
            terminalLayoutsByTabId: {}
          })
          // Why: hydrateWorkspaceSession no longer sets workspaceSessionReady.
          // The error path has no worktrees to reconnect, but must still flip
          // the flag so auto-tab-creation and session writes are unblocked.
          await reconnectPersistedTerminals()
        }
      }
      void fetchSettings()
      void initGitHubCache()
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [
    fetchRepos,
    fetchAllWorktrees,
    fetchSettings,
    initGitHubCache,
    hydratePersistedUI,
    hydrateWorkspaceSession,
    hydrateEditorSession,
    hydrateBrowserSession,
    reconnectPersistedTerminals
  ])

  useEffect(() => {
    setRuntimeGraphStoreStateGetter(useAppStore.getState)
    return () => {
      setRuntimeGraphStoreStateGetter(null)
    }
  }, [])

  useEffect(() => registerUpdaterBeforeUnloadBypass(), [])

  useEffect(() => {
    setRuntimeGraphSyncEnabled(workspaceSessionReady)
    return () => {
      setRuntimeGraphSyncEnabled(false)
    }
  }, [workspaceSessionReady])

  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    const timer = window.setTimeout(() => {
      // Why: setWorkspaceSession is a full replacement, not a merge.
      // Every call MUST include activeWorktreeIdsOnShutdown or it is
      // silently erased from disk.
      const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
        .filter(([, tabs]) => tabs.some((t) => t.ptyId))
        .map(([worktreeId]) => worktreeId)
      void window.api.session.set({
        activeRepoId,
        activeWorktreeId,
        activeTabId,
        tabsByWorktree,
        terminalLayoutsByTabId,
        activeWorktreeIdsOnShutdown,
        activeTabIdByWorktree,
        ...buildEditorSessionData(openFiles, activeFileIdByWorktree, activeTabTypeByWorktree),
        ...buildBrowserSessionData(browserTabsByWorktree, activeBrowserTabIdByWorktree)
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [
    workspaceSessionReady,
    activeRepoId,
    activeWorktreeId,
    activeTabId,
    tabsByWorktree,
    terminalLayoutsByTabId,
    openFiles,
    activeFileIdByWorktree,
    activeTabTypeByWorktree,
    activeTabIdByWorktree,
    browserTabsByWorktree,
    activeBrowserTabIdByWorktree
  ])

  // On shutdown, capture terminal scrollback buffers and flush to disk.
  // Runs synchronously in beforeunload: capture → Zustand set → sendSync → flush.
  useEffect(() => {
    const captureAndFlush = (): void => {
      if (!useAppStore.getState().workspaceSessionReady) {
        return
      }
      for (const capture of shutdownBufferCaptures) {
        try {
          capture()
        } catch {
          // Don't let one pane's failure block the rest.
        }
      }
      const state = useAppStore.getState()
      const activeWorktreeIdsOnShutdown = Object.entries(state.tabsByWorktree)
        .filter(([, tabs]) => tabs.some((t) => t.ptyId))
        .map(([worktreeId]) => worktreeId)
      window.api.session.setSync({
        activeRepoId: state.activeRepoId,
        activeWorktreeId: state.activeWorktreeId,
        activeTabId: state.activeTabId,
        tabsByWorktree: state.tabsByWorktree,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId,
        activeWorktreeIdsOnShutdown,
        activeTabIdByWorktree: state.activeTabIdByWorktree,
        ...buildEditorSessionData(
          state.openFiles,
          state.activeFileIdByWorktree,
          state.activeTabTypeByWorktree
        ),
        ...buildBrowserSessionData(state.browserTabsByWorktree, state.activeBrowserTabIdByWorktree)
      })
    }
    window.addEventListener('beforeunload', captureAndFlush)
    return () => window.removeEventListener('beforeunload', captureAndFlush)
  }, [])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    if (!hasSeenInitialSidebarStateRef.current) {
      hasSeenInitialSidebarStateRef.current = true
      return
    }

    // Why: the terminal's WebGL renderer can flash blank while the app shell
    // animates sidebar widths. Broadcasting the transition window lets active
    // terminals temporarily fall back to the DOM renderer just for that
    // animation, then restore GPU rendering after the layout settles.
    window.dispatchEvent(
      new CustomEvent('orca-layout-transition', {
        detail: { durationMs: SIDEBAR_TRANSITION_MS }
      })
    )
  }, [persistedUIReady, sidebarOpen, rightSidebarOpen])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.ui.set({
        sidebarWidth,
        rightSidebarWidth,
        groupBy,
        sortBy,
        showActiveOnly,
        filterRepoIds
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [
    persistedUIReady,
    sidebarWidth,
    rightSidebarWidth,
    groupBy,
    sortBy,
    showActiveOnly,
    filterRepoIds
  ])

  // Apply theme to document
  useEffect(() => {
    if (!settings) {
      return
    }

    const applyTheme = (dark: boolean): void => {
      document.documentElement.classList.toggle('dark', dark)
    }

    if (settings.theme === 'dark') {
      applyTheme(true)
      return undefined
    } else if (settings.theme === 'light') {
      applyTheme(false)
      return undefined
    } else {
      // system
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mq.matches)
      const handler = (e: MediaQueryListEvent): void => applyTheme(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings])

  // Refresh GitHub data (PR/issue status) when window regains focus
  useEffect(() => {
    const handler = (): void => {
      if (document.visibilityState === 'visible') {
        refreshAllGitHub()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [refreshAllGitHub])

  const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const hasTabBar = tabs.length >= 2
  const effectiveActiveTabId = activeTabId ?? tabs[0]?.id ?? null
  const activeTabCanExpand = effectiveActiveTabId
    ? (canExpandPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const effectiveActiveTabExpanded = effectiveActiveTabId
    ? (expandedPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const showTitlebarExpandButton =
    activeView !== 'settings' &&
    activeWorktreeId !== null &&
    !hasTabBar &&
    effectiveActiveTabExpanded
  const showSidebar = activeView !== 'settings'

  const handleToggleExpand = (): void => {
    if (!effectiveActiveTabId) {
      return
    }
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId: effectiveActiveTabId }
      })
    )
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) {
        return
      }
      // Accept Cmd on macOS, Ctrl on other platforms
      const mod = isMac ? e.metaKey : e.ctrlKey

      // Why: Cmd/Ctrl+P must be handled before the isEditableTarget guard
      // because contentEditable elements (e.g. the Tiptap rich markdown
      // editor) would otherwise swallow the event, making quick-open
      // unreachable while the rich editor has focus.
      if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'p' &&
        activeView !== 'settings' &&
        activeWorktreeId !== null
      ) {
        e.preventDefault()
        setQuickOpenVisible(true)
        return
      }

      // Why: Cmd/Ctrl+1–9 must be handled before the isEditableTarget guard so
      // the shortcut fires from any focus context — including sidebar search
      // input, Monaco editor, and contentEditable elements. This follows the
      // same pattern as Cmd+P above.
      if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        e.key >= '1' &&
        e.key <= '9' &&
        activeView !== 'settings'
      ) {
        const index = parseInt(e.key, 10) - 1
        const visibleIds = getVisibleWorktreeIds()
        if (index < visibleIds.length) {
          // Prevent the digit from being typed into the focused input/editor
          e.preventDefault()
          const store = useAppStore.getState()
          store.setActiveWorktree(visibleIds[index])
          // Scroll sidebar to reveal the activated card
          store.revealWorktreeInSidebar(visibleIds[index])
        }
        return
      }

      if (isEditableTarget(e.target)) {
        return
      }
      if (!mod) {
        return
      }

      // Cmd/Ctrl+B — toggle left sidebar
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
        return
      }

      // Cmd/Ctrl+L — toggle right sidebar
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        toggleRightSidebar()
        return
      }

      // Cmd/Ctrl+N — create worktree
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        if (!repos.some((repo) => isGitRepoKind(repo))) {
          return
        }
        e.preventDefault()
        openModal('create-worktree')
        return
      }

      // Cmd/Ctrl+Shift+E — toggle right sidebar / explorer tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
        return
      }

      // Cmd/Ctrl+Shift+F — toggle right sidebar / search tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setRightSidebarTab('search')
        setRightSidebarOpen(true)
        return
      }

      // Cmd/Ctrl+Shift+G — toggle right sidebar / source control tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        setRightSidebarTab('source-control')
        setRightSidebarOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeView,
    activeWorktreeId,
    openModal,
    repos,
    toggleSidebar,
    toggleRightSidebar,
    setRightSidebarTab,
    setRightSidebarOpen,
    setQuickOpenVisible
  ])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <div className="titlebar">
        {/* Why: the left section of the titlebar matches the sidebar width so
            tabs start exactly where the sidebar ends, creating a clean vertical
            alignment between the sidebar edge and the first tab. */}
        <div
          className="flex items-center shrink-0 overflow-hidden"
          style={{ width: showSidebar && sidebarOpen ? sidebarWidth : undefined }}
        >
          <div className={isMac && !isFullScreen ? 'titlebar-traffic-light-pad' : 'pl-2'} />
          <button
            className="sidebar-toggle"
            onClick={toggleSidebar}
            title={showSidebar ? 'Toggle sidebar' : 'Sidebar unavailable in settings'}
            aria-label={showSidebar ? 'Toggle sidebar' : 'Sidebar unavailable in settings'}
            disabled={!showSidebar}
          >
            <PanelLeft size={16} />
          </button>
          <div className="titlebar-title">Orca</div>
        </div>
        {/* Why: portal target for the TabBar rendered by Terminal.tsx.
            Hidden when tabs should not be visible (settings view, no active worktree)
            so the portal content does not leak through. */}
        <div
          id="titlebar-tabs"
          className={`flex flex-1 min-w-0 self-stretch${activeView === 'settings' || !activeWorktreeId ? ' hidden' : ''}`}
        />
        {showTitlebarExpandButton && (
          <button
            className="titlebar-icon-button"
            onClick={handleToggleExpand}
            title="Collapse pane"
            aria-label="Collapse pane"
            disabled={!activeTabCanExpand}
          >
            <Minimize2 size={14} />
          </button>
        )}
        <button
          className="sidebar-toggle mr-2"
          onClick={toggleRightSidebar}
          title={`Toggle right sidebar (${isMac ? '⌘L' : 'Ctrl+L'})`}
          aria-label="Toggle right sidebar"
          disabled={!showSidebar}
        >
          <PanelRight size={16} />
        </button>
      </div>
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        {showSidebar ? <Sidebar /> : null}
        <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
          <div className="flex flex-1 min-w-0 min-h-0 flex-col">
            <div
              className={
                activeView === 'settings' || !activeWorktreeId
                  ? 'hidden flex-1 min-w-0 min-h-0'
                  : 'flex flex-1 min-w-0 min-h-0'
              }
            >
              <Terminal />
            </div>
            {activeView === 'settings' ? <Settings /> : !activeWorktreeId ? <Landing /> : null}
          </div>
        </div>
        {/* Why: the right sidebar stays mounted even while "closed" so its
            width can animate from 0px to the saved width. Unmounting here made
            the panel pop in abruptly instead of matching the left sidebar's
            smooth expand/collapse behavior. */}
        {showSidebar ? <RightSidebar /> : null}
      </div>
      <QuickOpen />
      <ZoomOverlay />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

export default App
