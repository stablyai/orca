import { useEffect } from 'react'
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
  const hydratePersistedUI = useAppStore((s) => s.hydratePersistedUI)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)

  // Right sidebar + editor state
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const setQuickOpenVisible = useAppStore((s) => s.setQuickOpenVisible)

  // Subscribe to IPC push events
  useIpcEvents()

  const settings = useAppStore((s) => s.settings)

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        await fetchRepos()
        await fetchAllWorktrees()
        const persistedUI = await window.api.ui.get()
        const session = await window.api.session.get()
        if (!cancelled) {
          hydratePersistedUI(persistedUI)
          hydrateWorkspaceSession(session)
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
            filterRepoIds: [],
            uiZoomLevel: 0
          })
          hydrateWorkspaceSession({
            activeRepoId: null,
            activeWorktreeId: null,
            activeTabId: null,
            tabsByWorktree: {},
            terminalLayoutsByTabId: {}
          })
        }
      }
      void fetchSettings()
      void initGitHubCache()
    })()

    return () => {
      cancelled = true
    }
  }, [
    fetchRepos,
    fetchAllWorktrees,
    fetchSettings,
    initGitHubCache,
    hydratePersistedUI,
    hydrateWorkspaceSession
  ])

  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.session.set({
        activeRepoId,
        activeWorktreeId,
        activeTabId,
        tabsByWorktree,
        terminalLayoutsByTabId
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [
    workspaceSessionReady,
    activeRepoId,
    activeWorktreeId,
    activeTabId,
    tabsByWorktree,
    terminalLayoutsByTabId
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
      window.api.session.setSync({
        activeRepoId: state.activeRepoId,
        activeWorktreeId: state.activeWorktreeId,
        activeTabId: state.activeTabId,
        tabsByWorktree: state.tabsByWorktree,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId
      })
    }
    window.addEventListener('beforeunload', captureAndFlush)
    return () => window.removeEventListener('beforeunload', captureAndFlush)
  }, [])

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
        filterRepoIds
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [persistedUIReady, sidebarWidth, rightSidebarWidth, groupBy, sortBy, filterRepoIds])

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
      if (isEditableTarget(e.target)) {
        return
      }
      // Accept Cmd on macOS, Ctrl on other platforms
      const mod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (!mod) {
        return
      }

      // Cmd/Ctrl+P — quick open (go to file)
      if (
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

      // Cmd/Ctrl+N — create worktree
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        if (repos.length === 0) {
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
    repos.length,
    setRightSidebarTab,
    setRightSidebarOpen,
    setQuickOpenVisible
  ])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <div className="titlebar">
        <div className="titlebar-traffic-light-pad" />
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
        <div className="titlebar-spacer" />
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
          className="sidebar-toggle"
          onClick={toggleRightSidebar}
          title="Toggle right sidebar"
          aria-label="Toggle right sidebar"
          disabled={!showSidebar}
          style={{ marginRight: 12 }}
        >
          <PanelRight size={16} />
        </button>
      </div>
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        {showSidebar ? <Sidebar /> : null}
        <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
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
        {showSidebar && rightSidebarOpen ? <RightSidebar /> : null}
      </div>
      <QuickOpen />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

export default App
