/* eslint-disable max-lines */
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDefaultUIState } from '../../shared/constants'

import {
  ArrowLeft,
  ArrowRight,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight
} from 'lucide-react'
import logo from '../../../resources/logo.svg'
import { SYNC_FIT_PANES_EVENT, TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from './store'
import { useShallow } from 'zustand/react/shallow'
import { useIpcEvents } from './hooks/useIpcEvents'
import RetainedAgentsSyncGate from './components/dashboard/RetainedAgentsSyncGate'
import Sidebar from './components/Sidebar'
import Terminal from './components/Terminal'
import { shutdownBufferCaptures } from './components/terminal-pane/shutdown-buffer-captures'
import RightSidebar from './components/right-sidebar'
import { StatusBar } from './components/status-bar/StatusBar'
import { UpdateCard } from './components/UpdateCard'
import { StarNagCard } from './components/StarNagCard'
import { TelemetryFirstLaunchSurface } from './components/TelemetryFirstLaunchSurface'
import { ZoomOverlay } from './components/ZoomOverlay'
import { shouldShowOnboarding } from './components/onboarding/should-show-onboarding'
import { SshPassphraseDialog } from './components/settings/SshPassphraseDialog'
import { useGitStatusPolling } from './components/right-sidebar/useGitStatusPolling'
import { useEditorExternalWatch } from './hooks/useEditorExternalWatch'
import { useAutoAckViewedAgent } from './hooks/useAutoAckViewedAgent'
import {
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './runtime/sync-runtime-graph'
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop'
import { registerUpdaterBeforeUnloadBypass } from './lib/updater-beforeunload'
import { buildWorkspaceSessionPayload } from './lib/workspace-session'
import { countWorkingAgents, getWorkingAgentsPerWorktree } from './lib/agent-status'
import { activateAndRevealWorktree } from './lib/worktree-activation'
import { applyDocumentTheme } from './lib/document-theme'
import { isEditableTarget } from './lib/editable-target'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { findWorktreeById, getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory
} from '@/store/slices/worktree-nav-history'
import type { OnboardingState } from '../../shared/types'

const isMac = navigator.userAgent.includes('Mac')
const isWindows = !isMac && navigator.userAgent.includes('Windows')

// Why: 'hidden' titleBarStyle on Windows removes the native OS title bar,
// so we render our own minimize/maximize/close buttons.  These SVG icons match
// the Fluent/Win11 style: thin 10×10 paths on a 40×30 hit area.
function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    // Why: window:maximize-changed only fires on transitions, so a window
    // restored to a maximized state at startup would render the wrong icon
    // until the user first clicks the button. Seed from main on mount.
    let cancelled = false
    void window.api.ui.isMaximized().then((value) => {
      if (!cancelled) {
        setMaximized(value)
      }
    })
    const unsubscribe = window.api.ui.onMaximizeChanged(setMaximized)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return (
    <div className="window-controls">
      <button
        className="window-controls-btn"
        aria-label="Minimize"
        onClick={() => window.api.ui.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10v1H0z" fill="currentColor" />
        </svg>
      </button>
      <button
        className="window-controls-btn"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => window.api.ui.maximize()}
      >
        {maximized ? (
          // Restore icon (two overlapping squares)
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 0v2H0v8h8V8h2V0H2zm6 9H1V3h7v6zM9 7H8V2H3V1h6v6z" fill="currentColor" />
          </svg>
        ) : (
          // Maximize icon (single square outline)
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button
        className="window-controls-btn window-controls-close"
        aria-label="Close"
        // Why: IPC to main so the BrowserWindow 'close' event fires, which
        // sends 'window:close-requested' back to the renderer and keeps the
        // terminal-running confirmation guard active. window.close() is
        // unreliable in sandboxed renderers.
        onClick={() => window.api.ui.requestClose()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4-4-4z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}

const Landing = lazy(() => import('./components/Landing'))
const TaskPage = lazy(() => import('./components/TaskPage'))
const Settings = lazy(() => import('./components/settings/Settings'))
const QuickOpen = lazy(() => import('./components/QuickOpen'))
const WorktreeJumpPalette = lazy(() => import('./components/WorktreeJumpPalette'))
const NewWorkspaceComposerModal = lazy(() => import('./components/NewWorkspaceComposerModal'))
// Why: lazy-loaded so the WebP asset + overlay module aren't fetched unless
// the user opts into the experimental flag.
const PetOverlay = lazy(() => import('./components/pet/PetOverlay'))
// Why: lazy so onboarding's step modules + assets aren't fetched for users
// past first-launch. The gate `shouldShowOnboarding` lives in its own tiny
// module so no eager import path pulls OnboardingFlow into the main chunk.
const OnboardingFlow = lazy(() => import('./components/onboarding/OnboardingFlow'))

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
      reconnectPersistedTerminals: s.reconnectPersistedTerminals,
      setDeferredSshReconnectTargets: s.setDeferredSshReconnectTargets,
      setSshConnectionState: s.setSshConnectionState,
      hydratePersistedUI: s.hydratePersistedUI,
      openModal: s.openModal,
      closeModal: s.closeModal,
      toggleRightSidebar: s.toggleRightSidebar,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      updateSettings: s.updateSettings,
      pruneLastVisitedTimestamps: s.pruneLastVisitedTimestamps,
      seedActiveWorktreeLastVisitedIfMissing: s.seedActiveWorktreeLastVisitedIfMissing
    }))
  )

  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
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
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const petVisible = useAppStore((s) => s.petVisible)
  const canGoBackWorktree = useAppStore(canGoBackWorktreeHistory)
  const canGoForwardWorktree = useAppStore(canGoForwardWorktreeHistory)
  const titlebarLeftControlsRef = useRef<HTMLDivElement | null>(null)
  const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0)
  const [mountedLazyModalIds, setMountedLazyModalIds] = useState(() => new Set<string>())
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)

  // Subscribe to IPC push events
  useIpcEvents()
  // Why: retention must run at App level so the inline per-card agents list
  // always sees retained entries. If retention ran inside the sidebar-card
  // subtree, "done" agents would vanish any time the user collapsed a card's
  // inline agents section. The retention hooks are hosted inside
  // <RetainedAgentsSyncGate /> (a leaf component that renders null) rather
  // than being called inline here so its high-churn store subscriptions
  // (agentStatusByPaneKey + agentStatusEpoch tick at PTY event frequency)
  // do not re-render the App tree on every agent status update.
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
  useAutoAckViewedAgent()

  // Why: sidebar open/close flips width instantaneously. useLayoutEffect
  // runs synchronously after React commits the DOM but before paint, so
  // dispatching SYNC_FIT_PANES_EVENT here lets the terminal reflow in the
  // same frame as the width change — no "wrongly-sized terminal" transient
  // and no delayed snap. The later ResizeObserver rAF and 150ms debounced
  // fit both become no-ops because proposeDimensions() will match the
  // already-fitted cols/rows.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [sidebarOpen, rightSidebarOpen])

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
        // hydration has access to user preferences. Without this, settings
        // would still be null at hydration time.
        await actions.fetchSettings()
        if (!cancelled) {
          actions.hydratePersistedUI(persistedUI)
          actions.hydrateWorkspaceSession(session)
          actions.hydrateTabsSession(session)
          actions.hydrateEditorSession(session)
          actions.hydrateBrowserSession(session)
          // Why: prune lastVisitedAtByWorktreeId entries whose worktrees
          // no longer exist. Must run AFTER hydration — before this point,
          // async repo loads may not have populated worktreesByRepo yet and
          // pruning would delete timestamps for worktrees that are about to
          // appear. Seed the restored active worktree's timestamp if missing
          // so users upgrading from a pre-feature build don't see the active
          // worktree sink in the empty-query list.
          // See docs/cmd-j-empty-query-ordering.md.
          actions.pruneLastVisitedTimestamps()
          actions.seedActiveWorktreeLastVisitedIfMissing()
          await actions.fetchBrowserSessionProfiles()
          const onboardingState = await window.api.onboarding.get()
          if (!cancelled) {
            setOnboarding(onboardingState)
          }

          // Why: SSH connections must be re-established BEFORE terminal
          // reconnect so that reconnectPersistedTerminals can route SSH-backed
          // tabs through pty.attach on the relay. Passphrase-protected targets
          // are deferred to tab focus to avoid stacking credential dialogs at
          // startup before the user has context.
          const connectionIds = session.activeConnectionIdsAtShutdown ?? []
          if (connectionIds.length > 0) {
            try {
              const SSH_RECONNECT_TIMEOUT_MS = 15_000
              const allTargets = await window.api.ssh.listTargets()
              const targetMap = new Map(allTargets.map((t) => [t.id, t]))
              const targets = connectionIds.map((targetId) => ({
                targetId,
                needsPassphrase: targetMap.get(targetId)?.lastRequiredPassphrase ?? false
              }))

              const eagerTargets = targets.filter((t) => !t.needsPassphrase)
              const deferredTargets = targets.filter((t) => t.needsPassphrase)

              if (deferredTargets.length > 0) {
                actions.setDeferredSshReconnectTargets(deferredTargets.map((t) => t.targetId))
              }

              // Why: track which eager targets timed out so we can treat them
              // as deferred — the underlying ssh.connect() keeps running in the
              // main process, but reconnectPersistedTerminals won't see them as
              // connected. Adding them to the deferred list ensures PTYs get
              // reattached when the user focuses the tab (by which time the
              // slow connect will likely have succeeded).
              const timedOutTargets: string[] = []
              await Promise.allSettled(
                eagerTargets.map(({ targetId }) =>
                  Promise.race([
                    window.api.ssh.connect({ targetId }),
                    new Promise((_, reject) =>
                      setTimeout(
                        () => reject(new Error('SSH reconnect timeout')),
                        SSH_RECONNECT_TIMEOUT_MS
                      )
                    )
                  ]).catch((err) => {
                    const isTimeout =
                      err instanceof Error && err.message === 'SSH reconnect timeout'
                    if (isTimeout) {
                      timedOutTargets.push(targetId)
                    }
                    console.warn(`SSH auto-reconnect failed for ${targetId}:`, err)
                  })
                )
              )
              if (timedOutTargets.length > 0) {
                actions.setDeferredSshReconnectTargets([
                  ...deferredTargets.map((t) => t.targetId),
                  ...timedOutTargets
                ])
              }

              // Why: ssh.connect() resolves before the ssh:state-changed IPC
              // event updates sshConnectionStates in the store. Without this,
              // reconnectPersistedTerminals reads stale state and misclassifies
              // successfully connected targets as disconnected, stranding their
              // persisted PTYs. Polling getState ensures the store is current.
              for (const { targetId } of eagerTargets) {
                if (timedOutTargets.includes(targetId)) {
                  continue
                }
                try {
                  const state = await window.api.ssh.getState({ targetId })
                  console.warn(
                    `[ssh-restore] Polled state for ${targetId}: status=${state?.status}`
                  )
                  if (state?.status === 'connected') {
                    actions.setSshConnectionState(targetId, state)
                  }
                } catch {
                  /* best-effort */
                }
              }
            } catch (err) {
              console.warn('SSH startup reconnect failed:', err)
            }
          }

          await actions.reconnectPersistedTerminals(abortController.signal)
          syncZoomCSSVar()
        }
      } catch (error) {
        console.error('Failed to hydrate workspace session:', error)
        if (!cancelled) {
          actions.hydratePersistedUI(getDefaultUIState())
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
      for (const capture of shutdownBufferCaptures.values()) {
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
        hideDefaultBranchWorkspace,
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
    hideDefaultBranchWorkspace,
    filterRepoIds
  ])

  // Apply theme to document
  useEffect(() => {
    if (!settings) {
      return
    }

    if (settings.theme === 'dark') {
      applyDocumentTheme('dark')
      return undefined
    } else if (settings.theme === 'light') {
      applyDocumentTheme('light')
      return undefined
    } else {
      // system
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDocumentTheme('system')
      const handler = (): void => applyDocumentTheme('system')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(settings?.appFontFamily)
    )
  }, [settings?.appFontFamily])

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

      // Cmd/Ctrl+Alt+Arrow — worktree history back/forward. Handled before the
      // `mod && !alt` branch below since this is the one renderer-side shortcut
      // that intentionally requires Alt.
      if (
        e.altKey &&
        !e.shiftKey &&
        (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
        (e.code === 'ArrowLeft' || e.code === 'ArrowRight')
      ) {
        // Why: Back/Forward traverse mixed worktree + Tasks visits, so the
        // shortcut is active wherever the titlebar button cluster is (terminal
        // or tasks). Still suppressed in Settings to keep that view modal-ish.
        if (activeView !== 'terminal' && activeView !== 'tasks') {
          return
        }
        e.preventDefault()
        const store = useAppStore.getState()
        if (e.code === 'ArrowLeft') {
          store.goBackWorktree()
        } else {
          store.goForwardWorktree()
        }
        return
      }

      if (!mod) {
        return
      }

      // Cmd/Ctrl+B — toggle left sidebar
      if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
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
        e.preventDefault()
        actions.toggleRightSidebar()
        return
      }

      // Cmd/Ctrl+Shift+E — toggle right sidebar / explorer tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        actions.setRightSidebarTab('explorer')
        actions.setRightSidebarOpen(true)
        return
      }

      // Cmd/Ctrl+Shift+F — toggle right sidebar / search tab
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
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
        e.preventDefault()
        actions.setRightSidebarTab('source-control')
        actions.setRightSidebarOpen(true)
        return
      }

      // Cmd+Shift+I — toggle right sidebar / ports tab (macOS only).
      // Why: Ctrl+Shift+I is the built-in DevTools accelerator on Windows/Linux;
      // intercepting it would break an essential developer tool.
      if (isMac && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        actions.setRightSidebarTab('ports')
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

  useEffect(() => {
    if (
      activeModal !== 'quick-open' &&
      activeModal !== 'worktree-palette' &&
      activeModal !== 'new-workspace-composer'
    ) {
      return
    }
    setMountedLazyModalIds((currentIds) => {
      if (currentIds.has(activeModal)) {
        return currentIds
      }
      const nextIds = new Set(currentIds)
      // Why: lazy-load these modals only after first use, then keep them mounted
      // so repeat opens preserve their local state and avoid re-fetch flashes.
      nextIds.add(activeModal)
      return nextIds
    })
  }, [activeModal])

  // Why: extracted so both the full-width titlebar (settings/landing) and
  // the sidebar-width left header (workspace view) can share the same
  // controls without duplicating the agent badge popover.
  const titlebarLeftControls = (
    // Why: measure the ENTIRE row (traffic-light pad + sidebar toggle + agent
    // badge + back/forward group) so the sidebar-collapse spacer in
    // TabGroupPanel reserves enough width to clear the full floating
    // `titlebar-left`. Measuring only the inner control cluster left the
    // back/forward arrows hanging over the first tab when the sidebar was
    // collapsed (Cmd+B), producing a half-occluded, non-scrollable tab strip.
    <div ref={titlebarLeftControlsRef} className="flex h-full w-full shrink-0 items-center">
      <div className="flex h-full items-center">
        {isMac && !isFullScreen ? (
          <div className="titlebar-traffic-light-pad" />
        ) : isWindows ? (
          /* Why: on Windows the native title bar is hidden, so we render the
             Orca logo as a non-interactive identity anchor and a ··· button
             that pops up the application menu (the same menu revealed by Alt
             on the default autoHideMenuBar). */
          <>
            <img src={logo} alt="" aria-hidden className="titlebar-logo" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="titlebar-icon-button"
                  aria-label="Application menu"
                  onClick={() => window.api.ui.popupMenu()}
                >
                  <MoreHorizontal size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Application menu
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <div className="pl-2" />
        )}
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
                        {agents.map((agent) => (
                          <button
                            key={`${agent.tabId}:${agent.paneId ?? 'none'}:${agent.label}`}
                            className="titlebar-agent-hovercard-agent"
                            onClick={() => {
                              activateAndRevealWorktree(worktreeId)
                              activateTabAndFocusPane(agent.tabId, agent.paneId)
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
      {/* Why: Back/Forward traverse mixed worktree + Tasks history, so the
          cluster is shown wherever the history shortcut is live (terminal or
          tasks). Hidden in Settings to keep that view modal-ish. */}
      {(activeView === 'terminal' || activeView === 'tasks') && (
        <div className="ml-auto mr-3 flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goBackWorktree()}
                disabled={!canGoBackWorktree}
                aria-label="Go back"
              >
                <ArrowLeft size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {`Go back (${isMac ? '⌘⌥←' : 'Ctrl+Alt+←'})`}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goForwardWorktree()}
                disabled={!canGoForwardWorktree}
                aria-label="Go forward"
              >
                <ArrowRight size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {`Go forward (${isMac ? '⌘⌥→' : 'Ctrl+Alt+→'})`}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
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
          '--collapsed-sidebar-header-width': `${collapsedSidebarHeaderWidth}px`,
          // Why: consumed by anything that needs to avoid the fixed-position
          // window-controls overlay on Windows (floating sidebar toggle, right
          // sidebar header, etc.) without hardcoding 138px in multiple places.
          '--window-controls-width': isWindows ? '138px' : '0px'
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        {/* Why: leaf-mounted retention sync — hosting useDashboardData() +
            useRetainedAgentsSync() inside a null-rendering leaf keeps their
            high-churn store subscriptions from re-rendering the App tree. */}
        <RetainedAgentsSyncGate />
        <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
          {/* Why: the non-workspace titlebar lives inside this left+center
              wrapper so it does not span over the right-sidebar column —
              when the right sidebar is open, its own header anchors at the
              top alongside the titlebar instead of being pushed below it. */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Why: in workspace view (split groups always enabled), the
                full-width titlebar is removed so tab groups + terminal extend
                to the top of the window. Left titlebar controls move to a
                header above the sidebar. Settings, landing, and the tasks
                page keep the titlebar. */}
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
                {/* Why: when the right sidebar is open, its own header renders
                    an identical close button — hide this copy so only one is
                    visible at a time. */}
                {!rightSidebarOpen && rightSidebarToggle}
                {/* Why: reserve space so content is not obscured by the
                    fixed-position window-controls overlay on Windows. */}
                {isWindows && <div className="window-controls-titlebar-spacer" />}
              </div>
            ) : null}
            <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
              {showSidebar ? (
                workspaceActive ? (
                  /* Why: left column wraps the sidebar with a titlebar-height
                     header above it. The header holds the same controls
                     (traffic lights, sidebar toggle, "Orca" title, agent badge)
                     that the full-width titlebar held while the center and right
                     columns keep their own top strips at the same 36px height.
                     When the sidebar is collapsed, take this header out of flex
                     layout so the terminal/editor reclaim the left edge instead of
                     leaving behind a content-width blank strip. */
                  <div
                    className={`flex min-h-0 flex-col shrink-0${sidebarOpen ? '' : ' relative w-0 overflow-visible'}`}
                  >
                    <div
                      // Why: when the sidebar is collapsed, titlebar-left floats
                      // absolutely on top of the center column's own `border-l`
                      // (see TabGroupSplitLayout), occluding that seam. Add a
                      // `border-r` in the floating state so the vertical line
                      // between the traffic-light/nav cluster and the tab strip
                      // stays visible in both states.
                      className={`titlebar-left${sidebarOpen ? '' : ' absolute top-0 left-0 z-10 border-r border-border'}`}
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
                      {/* Why: the workspace-view wrapper adds a fixed 36px header
                          above the sidebar. Without a flex-1/min-h-0 slot here,
                          the sidebar falls back to its content height, so the
                          worktree list loses its scroll viewport and the fixed
                          bottom toolbar (including Add Project) gets pushed offscreen. */}
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
                    open or closed. Match the RightSidebar header's 36px height and
                    top-0 anchor so the icon's vertical center is identical between
                    open and closed states — otherwise toggling makes the icon jump
                    a few pixels, which reads as layout jitter. */}
                {workspaceActive && !rightSidebarOpen && (
                  <div
                    className="absolute top-0 z-10 flex items-center h-[36px]"
                    style={
                      {
                        right: 'var(--window-controls-width)',
                        WebkitAppRegion: 'no-drag'
                      } as React.CSSProperties
                    }
                  >
                    {rightSidebarToggle}
                    {/* Why: the fixed-position window-controls overlay (138px,
                        top-right) sits on top of this floating toggle on Windows.
                        Reserve its width so the toggle stays clickable. */}
                    {isWindows && <div className="window-controls-titlebar-spacer" />}
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
                  <Suspense fallback={null}>
                    {activeView === 'settings' ? <Settings /> : null}
                    {activeView === 'tasks' ? <TaskPage /> : null}
                    {activeView === 'terminal' && !activeWorktreeId ? <Landing /> : null}
                  </Suspense>
                </div>
              </div>
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
        <Suspense fallback={null}>
          {mountedLazyModalIds.has('new-workspace-composer') ? <NewWorkspaceComposerModal /> : null}
        </Suspense>
      </TooltipProvider>
      <Suspense fallback={null}>
        {mountedLazyModalIds.has('quick-open') ? <QuickOpen /> : null}
        {mountedLazyModalIds.has('worktree-palette') ? <WorktreeJumpPalette /> : null}
      </Suspense>
      {/* Why: mount PetOverlay only when the experimental flag is on AND
          the user hasn't hit "Hide pet" in the status-bar menu. Both
          conditions must be true — see design doc (pet-overlay.md) on why
          the two toggles are kept independent. */}
      {petEnabled && petVisible ? (
        <Suspense fallback={null}>
          <PetOverlay />
        </Suspense>
      ) : null}
      <UpdateCard />
      <StarNagCard />
      {/* Why: the existing-user opt-in banner mounts at App root so it
          renders once per renderer session, not per view. It gates
          internally on the cohort markers populated by the migration,
          so it only shows for users who installed before the telemetry
          release and have not yet resolved consent. New users get no
          first-launch surface — see telemetry-plan.md §First-launch
          experience. */}
      <TelemetryFirstLaunchSurface />
      <ZoomOverlay />
      <SshPassphraseDialog />
      {onboarding && shouldShowOnboarding(onboarding) ? (
        <Suspense fallback={null}>
          <OnboardingFlow onboarding={onboarding} onOnboardingChange={setOnboarding} />
        </Suspense>
      ) : null}
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      {/* Why: rendered last so it sits after all -webkit-app-region:drag elements
          in DOM order. Electron's hit-test for drag regions is DOM-order-based and
          ignores z-index — placing WindowControls earlier caused the drag region to
          win, making the buttons unclickable. */}
      {isWindows && <WindowControls />}
    </div>
  )
}

export default App
