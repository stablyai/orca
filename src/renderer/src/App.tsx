/* eslint-disable max-lines */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_STATUS_BAR_ITEMS, DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../shared/constants'

import { Minimize2, PanelLeft, PanelRight } from 'lucide-react'
import { FOCUS_TERMINAL_PANE_EVENT, TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from './store'
import { useShallow } from 'zustand/react/shallow'
import { useIpcEvents } from './hooks/useIpcEvents'
import Sidebar from './components/Sidebar'
import Terminal from './components/Terminal'
import { shutdownBufferCaptures } from './components/terminal-pane/TerminalPane'
import Landing from './components/Landing'
import TaskPage from './components/TaskPage'
import Settings from './components/settings/Settings'
import RightSidebar from './components/right-sidebar'
import QuickOpen from './components/QuickOpen'
import WorktreeJumpPalette from './components/WorktreeJumpPalette'
import NewWorkspaceComposerModal from './components/NewWorkspaceComposerModal'
import { StatusBar } from './components/status-bar/StatusBar'
import { UpdateCard } from './components/UpdateCard'
import { StarNagCard } from './components/StarNagCard'
import { ZoomOverlay } from './components/ZoomOverlay'
import { SshPassphraseDialog } from './components/settings/SshPassphraseDialog'
import { useGitStatusPolling } from './components/right-sidebar/useGitStatusPolling'
import { useEditorExternalWatch } from './hooks/useEditorExternalWatch'
import {
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './runtime/sync-runtime-graph'
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop'
import { registerUpdaterBeforeUnloadBypass } from './lib/updater-beforeunload'
import { buildWorkspaceSessionPayload } from './lib/workspace-session'
import { countWorkingAgents, getWorkingAgentsPerWorktree } from './lib/agent-status'
import { activateAndRevealWorktree } from './lib/worktree-activation'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { findWorktreeById, getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { dispatchClearModifierHints } from './hooks/useModifierHint'

const isMac = navigator.userAgent.includes('Mac')

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
  // Why: Zustand actions are referentially stable, but each individual
  // useAppStore(s => s.someAction) still registers a subscription that React
  // must check on every store mutation. Consolidating 19 action refs into one
  // useShallow subscription means one equality check instead of 19.
  const actions = useAppStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      fetchRepos: s.fetchRepos,
      fetchAllWorktrees: s.fetchAllWorktrees,
      fetchSettings: s.fetchSettings,
      initGitHubCache: s.initGitHubCache,
      refreshAllGitHub: s.refreshAllGitHub,
      hydrateWorkspaceSession: s.hydrateWorkspaceSession,
      hydrateTabsSession: s.hydrateTabsSession,
      hydrateEditorSession: s.hydrateEditorSession,
      hydrateBrowserSession: s.hydrateBrowserSession,
      fetchBrowserSessionProfiles: s.fetchBrowserSessionProfiles,
      fetchDetectedBrowsers: s.fetchDetectedBrowsers,
      reconnectPersistedTerminals: s.reconnectPersistedTerminals,
      hydratePersistedUI: s.hydratePersistedUI,
      openModal: s.openModal,
      closeModal: s.closeModal,
      toggleRightSidebar: s.toggleRightSidebar,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      updateSettings: s.updateSettings
    }))
  )

  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const agentInputs = useAppStore(
    useShallow((s) => ({
      tabsByWorktree: s.tabsByWorktree,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      worktreesByRepo: s.worktreesByRepo
    }))
  )
  const activeAgentCount = useMemo(() => countWorkingAgents(agentInputs), [agentInputs])
  const workingAgentsPerWorktree = useMemo(
    () => getWorkingAgentsPerWorktree(agentInputs),
    [agentInputs]
  )
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const canExpandPaneByTabId = useAppStore((s) => s.canExpandPaneByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const titlebarLeftControlsRef = useRef<HTMLDivElement | null>(null)
  const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0)

  // Subscribe to IPC push events
  useIpcEvents()
  // Why: git conflict-operation state also drives the worktree cards. Polling
  // cannot live under RightSidebar because App unmounts that subtree when the
  // sidebar is closed, which leaves stale "Rebasing"/"Merging" badges behind
  // until some unrelated view remount happens to refresh them.
  useGitStatusPolling()
  // Why: the editor must hear external filesystem changes regardless of
  // which right-sidebar panel is visible (Explorer unmounts when the user
  // switches to Source Control or Checks). Wiring this at App level mirrors
  // VSCode's workbench-scoped `TextFileEditorModelManager`, which reloads
  // clean models from a single always-on file-change subscription instead
  // of tying reloads to the Explorer UI lifecycle.
  useEditorExternalWatch()
  useGlobalFileDrop()

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false
    // Why: AbortController must be declared outside the async block so the
    // cleanup function can abort it. Under StrictMode the effect runs twice;
    // without this, the first (unmounted) pass would keep spawning PTYs.
    const abortController = new AbortController()

    void (async () => {
      try {
        await actions.fetchRepos()
        await actions.fetchAllWorktrees()
        const persistedUI = await window.api.ui.get()
        const session = await window.api.session.get()
        // Why: settings must be loaded before hydrateWorkspaceSession so that
        // it can read experimentalTerminalDaemon to decide whether to stage
        // pendingReconnectPtyIdByTabId. Without this, opted-in daemon users
        // would silently lose session reattach on every launch because
        // s.settings would still be null at hydration time.
        await actions.fetchSettings()
        if (!cancelled) {
          actions.hydratePersistedUI(persistedUI)
          actions.hydrateWorkspaceSession(session)
          actions.hydrateTabsSession(session)
          actions.hydrateEditorSession(session)
          actions.hydrateBrowserSession(session)
          await actions.fetchBrowserSessionProfiles()
          await actions.fetchDetectedBrowsers()
          await actions.reconnectPersistedTerminals(abortController.signal)
          syncZoomCSSVar()
        }
      } catch (error) {
        console.error('Failed to hydrate workspace session:', error)
        if (!cancelled) {
          actions.hydratePersistedUI({
            lastActiveRepoId: null,
            lastActiveWorktreeId: null,
            sidebarWidth: 280,
            rightSidebarWidth: 350,
            groupBy: 'none',
            sortBy: 'name',
            showActiveOnly: false,
            filterRepoIds: [],
            collapsedGroups: [],
            uiZoomLevel: 0,
            editorFontZoomLevel: 0,
            worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
            statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
            statusBarVisible: true,
            dismissedUpdateVersion: null,
            lastUpdateCheckAt: null
          })
          actions.hydrateWorkspaceSession({
            activeRepoId: null,
            activeWorktreeId: null,
            activeTabId: null,
            tabsByWorktree: {},
            terminalLayoutsByTabId: {}
          })
          // Why: hydrateWorkspaceSession no longer sets workspaceSessionReady.
          // The error path has no worktrees to reconnect, but must still flip
          // the flag so auto-tab-creation and session writes are unblocked.
          await actions.reconnectPersistedTerminals()
        }
      }
      void actions.initGitHubCache()
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [actions])

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

  // Why: session persistence never drives JSX — it only writes to disk.
  // Using a Zustand subscribe() outside React removes ~15 subscriptions from
  // App's render cycle, eliminating re-renders on every tab/file/browser change.
  useEffect(() => {
    let timer: number | null = null
    const unsub = useAppStore.subscribe((state) => {
      if (!state.workspaceSessionReady) {
        return
      }
      if (timer) {
        window.clearTimeout(timer)
      }
      timer = window.setTimeout(() => {
        timer = null
        void window.api.session.set(buildWorkspaceSessionPayload(state))
      }, 150)
    })
    return () => {
      unsub()
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [])

  // On shutdown, capture terminal scrollback buffers and flush to disk.
  // Runs synchronously in beforeunload: capture → Zustand set → sendSync → flush.
  useEffect(() => {
    // Why: beforeunload fires twice during a manual quit — once from the
    // synthetic dispatch in the onWindowCloseRequested handler (captures
    // good data while TerminalPanes are still mounted), and again from the
    // native window close triggered by confirmWindowClose(). Between these
    // two firings, PTY exit events can arrive and unmount TerminalPanes,
    // emptying shutdownBufferCaptures. The guard prevents the second call
    // from overwriting the good session data with an empty snapshot.
    let shutdownBuffersCaptured = false
    const captureAndFlush = (): void => {
      if (shutdownBuffersCaptured) {
        return
      }
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
      window.api.session.setSync(buildWorkspaceSessionPayload(state))
      shutdownBuffersCaptured = true
    }
    window.addEventListener('beforeunload', captureAndFlush)
    return () => window.removeEventListener('beforeunload', captureAndFlush)
  }, [])

  // Why there is no periodic scrollback save: PR #461 added a 3-minute
  // setInterval that re-serialized every mounted TerminalPane's scrollback
  // so a crash wouldn't lose in-session output. With many panes of
  // accumulated output, each tick blocked the renderer main thread for
  // several seconds (serialize is synchronous and does a binary search on
  // >512KB buffers), causing visible input lag across the whole app.
  // The durable replacement is the out-of-process terminal daemon
  // (PR #729), which preserves buffers across renderer crashes with no
  // main-thread work. Non-daemon users lose in-session scrollback on an
  // unexpected exit — an acceptable tradeoff vs. periodic UI stalls, and
  // in line with how most terminal apps behave.

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
        actions.refreshAllGitHub()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [actions])

  // Why: v1.3.0 shipped the persistent-terminal daemon ON by default. v1.3.1+
  // defaults it OFF and gates it behind an Experimental toggle. On the first
  // launch after that upgrade, main detects a still-running daemon, shuts it
  // down (killing any surviving `sleep 9999`-style sessions), and stashes a
  // one-shot notice. We consume that notice here and inform the user so their
  // vanished sessions don't look like a bug. The renderer-side
  // `experimentalTerminalDaemonNoticeShown` flag guarantees the toast fires at
  // most once per install, even if main stashes a notice again on a later
  // launch.
  const transitionNoticeHandledRef = useRef(false)
  useEffect(() => {
    if (!settings || transitionNoticeHandledRef.current) {
      return
    }
    if (settings.experimentalTerminalDaemonNoticeShown) {
      transitionNoticeHandledRef.current = true
      return
    }
    transitionNoticeHandledRef.current = true
    void (async () => {
      let notice: { killedCount: number } | null = null
      try {
        notice = await window.api.app.consumeDaemonTransitionNotice()
      } catch {
        // Informational only — if the IPC fails, don't fire the toast and
        // don't flip the "shown" flag so we can retry on next launch.
        return
      }
      if (!notice) {
        return
      }
      const killedCount = notice.killedCount
      const killedClause =
        killedCount > 0
          ? ` Cleaned up ${killedCount} background session${killedCount === 1 ? '' : 's'} from the previous version.`
          : ''
      toast.info('Persistent terminal sessions are now opt-in.', {
        description: `${killedClause} You can re-enable them in Settings → Experimental.`.trim(),
        duration: 15000,
        action: {
          label: 'Open settings',
          onClick: () => {
            useAppStore.getState().openSettingsTarget({
              pane: 'experimental',
              repoId: null
            })
            useAppStore.getState().openSettingsPage()
          }
        }
      })
      try {
        await actions.updateSettings({ experimentalTerminalDaemonNoticeShown: true })
      } catch {
        // If persistence fails, the toast may re-fire on a later launch —
        // acceptable tradeoff vs. silently dropping the notification.
      }
    })()
  }, [actions, settings])

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
    activeView === 'terminal' &&
    activeWorktreeId !== null &&
    !hasTabBar &&
    effectiveActiveTabExpanded
  const showSidebar = activeView !== 'settings'
  // Why: when a worktree is active (split groups always enabled), the
  // full-width titlebar is replaced by a sidebar-width left header so the
  // terminal + tab groups extend to the very top of the window.
  const workspaceActive = activeView !== 'settings' && activeWorktreeId !== null
  // Why: suppress right sidebar controls on the tasks page since that surface
  // is intentionally distraction-free (no right sidebar).
  const showRightSidebarControls = activeView !== 'settings' && activeView !== 'tasks'

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
      // Why: child-component handlers (e.g. terminal search Cmd+G / Cmd+Shift+G)
      // register on the same window capture phase and fire first. If they already
      // called preventDefault, this handler must not also act on the event —
      // otherwise both actions execute (e.g. search navigation AND sidebar open).
      if (e.defaultPrevented) {
        return
      }
      // Accept Cmd on macOS, Ctrl on other platforms
      const mod = isMac ? e.metaKey : e.ctrlKey

      // Note: some app-level shortcuts are also intercepted via
      // before-input-event in createMainWindow.ts so they still work when a
      // browser guest has focus. The renderer keeps matching handlers for
      // local-focus cases and to preserve the same guards in one place.

      // Why: keep this guard. TipTap's Cmd+B bold binding depends on the
      // window-level handler *not* toggling the sidebar when focus lives in an
      // editable surface. The main-process before-input-event already carves out
      // Cmd+B for the markdown editor (see createMainWindow.ts +
      // docs/markdown-cmd-b-bold-design.md), but this renderer-side fallback
      // still covers the blur→press IPC race and any non-carved editable surface.
      if (isEditableTarget(e.target)) {
        return
      }
      if (!mod) {
        return
      }

      // Cmd/Ctrl+B — toggle left sidebar
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        dispatchClearModifierHints()
        e.preventDefault()
        actions.toggleSidebar()
        return
      }

      // Why: Cmd/Ctrl+N is handled via the main-process before-input-event
      // allowlist (see window-shortcut-policy.ts / useIpcEvents.ts) so it works
      // globally — including when focus lives inside the markdown rich editor
      // (contentEditable) or a browser guest webContents, both of which bypass
      // this renderer-side window keydown listener.

      // Why: the tasks page should not be able to reveal the right sidebar at
      // all, because that surface is intentionally distraction-free.
      if (activeView === 'tasks') {
        return
      }

      // Cmd/Ctrl+L — toggle right sidebar
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
        dispatchClearModifierHints()
        e.preventDefault()
        actions.toggleRightSidebar()
        return
      }

      // Cmd/Ctrl+Shift+E — toggle right sidebar / explorer tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        dispatchClearModifierHints()
        e.preventDefault()
        actions.setRightSidebarTab('explorer')
        actions.setRightSidebarOpen(true)
        return
      }

      // Cmd/Ctrl+Shift+F — toggle right sidebar / search tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        dispatchClearModifierHints()
        e.preventDefault()
        actions.setRightSidebarTab('search')
        actions.setRightSidebarOpen(true)
        return
      }

      // Cmd/Ctrl+Shift+G — toggle right sidebar / source control tab.
      // Skip when terminal search is open — Cmd+Shift+G means "find previous"
      // in that context (handled by keyboard-handlers.ts). Both listeners share
      // the window capture phase and registration order can vary with React
      // effect re-runs, so a DOM check is the reliable coordination mechanism.
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        if (document.querySelector('[data-terminal-search-root]')) {
          return
        }
        dispatchClearModifierHints()
        e.preventDefault()
        actions.setRightSidebarTab('source-control')
        actions.setRightSidebarOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeView, activeWorktreeId, actions])

  useLayoutEffect(() => {
    const controls = titlebarLeftControlsRef.current
    if (!controls) {
      return
    }

    const updateWidth = (): void => {
      setCollapsedSidebarHeaderWidth(controls.getBoundingClientRect().width)
    }

    updateWidth()
    const observer = new ResizeObserver(() => {
      updateWidth()
    })
    observer.observe(controls)
    return () => observer.disconnect()
  }, [
    activeAgentCount,
    isFullScreen,
    settings?.showTitlebarAgentActivity,
    showSidebar,
    workspaceActive,
    sidebarOpen
  ])

  // Why: extracted so both the full-width titlebar (settings/landing) and
  // the sidebar-width left header (workspace view) can share the same
  // controls without duplicating the agent badge popover.
  const titlebarLeftControls = (
    <div ref={titlebarLeftControlsRef} className="flex h-full shrink-0 items-center">
      <div className={isMac && !isFullScreen ? 'titlebar-traffic-light-pad' : 'pl-2'} />
      {showSidebar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="sidebar-toggle"
              onClick={actions.toggleSidebar}
              aria-label="Toggle sidebar"
            >
              <PanelLeft size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {`Toggle sidebar (${isMac ? '⌘B' : 'Ctrl+B'})`}
          </TooltipContent>
        </Tooltip>
      )}
      {settings?.showTitlebarAgentActivity !== false ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className={`titlebar-agent-badge${activeAgentCount === 0 ? ' titlebar-agent-badge-idle' : ''}`}
              aria-label={`${activeAgentCount} ${activeAgentCount === 1 ? 'agent' : 'agents'} active`}
            >
              <span
                className={`titlebar-agent-badge-dot${activeAgentCount === 0 ? ' titlebar-agent-badge-dot-idle' : ''}`}
                aria-hidden
              />
              <span className="titlebar-agent-badge-count">{activeAgentCount}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" sideOffset={6} className="titlebar-agent-hovercard">
            <div
              className={`titlebar-agent-hovercard-header${activeAgentCount > 0 ? ' titlebar-agent-hovercard-header-with-list' : ''}`}
            >
              {activeAgentCount === 0
                ? 'No agents active'
                : `${activeAgentCount} ${activeAgentCount === 1 ? 'agent' : 'agents'} active`}
            </div>
            {activeAgentCount > 0 && (
              <div className="titlebar-agent-hovercard-list">
                {Object.entries(workingAgentsPerWorktree).map(([worktreeId, { agents }]) => {
                  const wt = findWorktreeById(worktreesByRepo, worktreeId)
                  // Why: when a transient git error causes worktreesByRepo to
                  // lose a worktree, the raw worktreeId (uuid::path) is not
                  // useful. Extract a cross-platform path basename as a
                  // readable fallback.
                  const sepIdx = worktreeId.indexOf('::')
                  const pathPart = sepIdx !== -1 ? worktreeId.slice(sepIdx + 2) : worktreeId
                  const fallbackName = pathPart.split(/[\\/]/).pop() || pathPart
                  return (
                    <div key={worktreeId}>
                      <button
                        className="titlebar-agent-hovercard-worktree"
                        onClick={() => {
                          // Why: if the worktree is missing from worktreesByRepo
                          // (transient git error cleared the list), refresh the
                          // repo's worktrees before navigating so the activation
                          // lookup succeeds instead of silently failing.
                          if (!wt) {
                            const repoId = getRepoIdFromWorktreeId(worktreeId)
                            void useAppStore
                              .getState()
                              .fetchWorktrees(repoId)
                              .then(() => {
                                activateAndRevealWorktree(worktreeId)
                              })
                            return
                          }
                          activateAndRevealWorktree(worktreeId)
                        }}
                      >
                        <span className="titlebar-agent-hovercard-name">
                          {wt?.displayName ?? fallbackName}
                        </span>
                      </button>
                      {agents.map((agent, index) => (
                        <button
                          key={index}
                          className="titlebar-agent-hovercard-agent"
                          onClick={() => {
                            activateAndRevealWorktree(worktreeId)
                            useAppStore.getState().setActiveTab(agent.tabId)
                            if (agent.paneId !== null) {
                              // Why: a split-terminal tab can host multiple
                              // agents. After selecting the tab, wait one
                              // frame so the active TerminalPane can mount
                              // and then focus the specific pane the user
                              // clicked instead of leaving whichever pane
                              // was previously active highlighted.
                              requestAnimationFrame(() => {
                                window.dispatchEvent(
                                  new CustomEvent(FOCUS_TERMINAL_PANE_EVENT, {
                                    detail: { tabId: agent.tabId, paneId: agent.paneId }
                                  })
                                )
                              })
                            }
                          }}
                        >
                          <span className="titlebar-agent-hovercard-agent-label">
                            {agent.label}
                          </span>
                          <span className="titlebar-agent-hovercard-agent-dot" />
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
            <button
              className="titlebar-agent-hovercard-hide"
              onClick={() => {
                void actions.updateSettings({ showTitlebarAgentActivity: false })
                toast('Agent activity badge hidden', {
                  description: 'You can turn it back on in Settings → Appearance.',
                  duration: Infinity,
                  dismissible: true
                })
              }}
            >
              Hide from titlebar
            </button>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )

  const rightSidebarToggle = showRightSidebarControls ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="sidebar-toggle mr-2"
          onClick={actions.toggleRightSidebar}
          aria-label="Toggle right sidebar"
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {`Toggle right sidebar (${isMac ? '⌘L' : 'Ctrl+L'})`}
      </TooltipContent>
    </Tooltip>
  ) : null

  useEffect(() => {
    if (activeView === 'tasks' && rightSidebarOpen) {
      // Why: hide the right sidebar immediately when entering the tasks page
      // so a previous open state can't bleed into that distraction-free view.
      actions.setRightSidebarOpen(false)
    }
  }, [activeView, rightSidebarOpen, actions])

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={
        {
          '--collapsed-sidebar-header-width': `${collapsedSidebarHeaderWidth}px`
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        {/* Why: in workspace view (split groups always enabled), the full-width
            titlebar is removed so tab groups + terminal extend to the top of
            the window. Left titlebar controls move to a header above the sidebar.
            Settings, landing, and the tasks page keep the full-width titlebar. */}
        {!workspaceActive ? (
          <div className="titlebar">
            <div
              className={`flex items-center${showSidebar && sidebarOpen ? ' overflow-hidden shrink-0' : ' shrink-0 mr-2'}`}
              style={{ width: showSidebar && sidebarOpen ? sidebarWidth : undefined }}
            >
              {titlebarLeftControls}
            </div>
            <div
              id="titlebar-tabs"
              className={`flex flex-1 min-w-0 self-stretch${activeView !== 'terminal' || !activeWorktreeId ? ' invisible pointer-events-none' : ''}`}
            />
            {showTitlebarExpandButton && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="titlebar-icon-button"
                    onClick={handleToggleExpand}
                    aria-label="Collapse pane"
                    disabled={!activeTabCanExpand}
                  >
                    <Minimize2 size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Collapse pane
                </TooltipContent>
              </Tooltip>
            )}
            {rightSidebarToggle}
          </div>
        ) : null}
        <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
          {showSidebar ? (
            workspaceActive ? (
              /* Why: left column wraps the sidebar with a titlebar-height
                 header above it. The header holds the same controls
                 (traffic lights, sidebar toggle, "Orca" title, agent badge)
                 that the full-width titlebar held while the center and right
                 columns keep their own top strips at the same 42px height.
                 When the sidebar is collapsed, take this header out of flex
                 layout so the terminal/editor reclaim the left edge instead of
                 leaving behind a content-width blank strip. */
              <div
                className={`flex min-h-0 flex-col shrink-0${sidebarOpen ? '' : ' relative w-0 overflow-visible'}`}
              >
                <div
                  className={`titlebar-left${sidebarOpen ? '' : ' absolute top-0 left-0 z-10'}`}
                  style={{
                    // Why: the Sidebar resize hook updates the sidebar DOM width
                    // directly during drag and only persists to Zustand on
                    // mouseup. In workspace view, size this header from the
                    // wrapper's live width so it tracks those in-flight resizes
                    // instead of leaving a stale-width gap until the drag ends.
                    width: sidebarOpen ? '100%' : undefined
                  }}
                >
                  {titlebarLeftControls}
                </div>
                <div className="flex min-h-0 flex-1">
                  {/* Why: the workspace-view wrapper adds a fixed 42px header
                      above the sidebar. Without a flex-1/min-h-0 slot here,
                      the sidebar falls back to its content height, so the
                      worktree list loses its scroll viewport and the fixed
                      bottom toolbar (including Add Repo) gets pushed offscreen. */}
                  <Sidebar />
                </div>
              </div>
            ) : (
              <Sidebar />
            )
          ) : null}
          <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
            {/* Why: right sidebar toggle floats at the top-right of the center
                column so it's always accessible whether the right sidebar is
                open or closed. Its height matches the 42px workspace strip
                used by the sidebar and tab rows. */}
            {workspaceActive && !rightSidebarOpen && (
              <div className="absolute top-0 right-0 z-10 flex items-center h-[42px]">
                {rightSidebarToggle}
              </div>
            )}
            <div className="flex flex-1 min-w-0 min-h-0 flex-col">
              <div
                className={
                  activeView !== 'terminal' || !activeWorktreeId
                    ? 'hidden flex-1 min-w-0 min-h-0'
                    : 'flex flex-1 min-w-0 min-h-0'
                }
              >
                <Terminal />
              </div>
              {activeView === 'settings' ? <Settings /> : null}
              {activeView === 'tasks' ? <TaskPage /> : null}
              {activeView === 'terminal' && !activeWorktreeId ? <Landing /> : null}
            </div>
          </div>
          {/* Why: keep RightSidebar mounted even when closed so that its
              child components (FileExplorer, SourceControl, etc.) and their
              filesystem watchers + cached directory trees survive across
              open/close toggles. Unmount on the tasks view since that
              surface is intentionally distraction-free. */}
          {showRightSidebarControls ? <RightSidebar /> : null}
        </div>
        <StatusBar />
        {/* Why: NewWorkspaceComposerCard renders Radix <Tooltip>s that crash
            when mounted outside a TooltipProvider ancestor. Keep the global
            composer modal inside this provider so the card renders safely
            whether triggered from Cmd+J or any future entry point. */}
        <NewWorkspaceComposerModal />
      </TooltipProvider>
      <QuickOpen />
      <WorktreeJumpPalette />
      <UpdateCard />
      <StarNagCard />
      <ZoomOverlay />
      <SshPassphraseDialog />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

export default App
