import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_STATUS_BAR_ITEMS, DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../shared/constants';
import { isGitRepoKind } from '../../shared/repo-kind';
import { Minimize2, PanelLeft, PanelRight } from 'lucide-react';
import { FOCUS_TERMINAL_PANE_EVENT, TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal';
import { syncZoomCSSVar } from '@/lib/ui-zoom';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppStore } from './store';
import { useShallow } from 'zustand/react/shallow';
import { useIpcEvents } from './hooks/useIpcEvents';
import Sidebar from './components/Sidebar';
import Terminal from './components/Terminal';
import { shutdownBufferCaptures } from './components/terminal-pane/TerminalPane';
import Landing from './components/Landing';
import NewWorkspacePage from './components/NewWorkspacePage';
import Settings from './components/settings/Settings';
import RightSidebar from './components/right-sidebar';
import QuickOpen from './components/QuickOpen';
import WorktreeJumpPalette from './components/WorktreeJumpPalette';
import NewWorkspaceComposerModal from './components/NewWorkspaceComposerModal';
import { StatusBar } from './components/status-bar/StatusBar';
import { UpdateCard } from './components/UpdateCard';
import { ZoomOverlay } from './components/ZoomOverlay';
import { SshPassphraseDialog } from './components/settings/SshPassphraseDialog';
import { useGitStatusPolling } from './components/right-sidebar/useGitStatusPolling';
import { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } from './runtime/sync-runtime-graph';
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop';
import { registerUpdaterBeforeUnloadBypass } from './lib/updater-beforeunload';
import { buildWorkspaceSessionPayload } from './lib/workspace-session';
import { countWorkingAgents, getWorkingAgentsPerWorktree } from './lib/agent-status';
import { activateAndRevealWorktree } from './lib/worktree-activation';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { findWorktreeById, getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers';
import { dispatchClearModifierHints } from './hooks/useModifierHint';
const isMac = navigator.userAgent.includes('Mac');
function isEditableTarget(target) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    // xterm.js focuses a hidden <textarea class="xterm-helper-textarea"> for
    // keyboard input.  That element IS an editable target, but we must NOT
    // suppress global shortcuts when the terminal itself is focused — otherwise
    // Cmd/Ctrl+P and other app-level keybindings become unreachable.
    if (target.classList.contains('xterm-helper-textarea')) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    return (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
        null);
}
function App() {
    // Why: Zustand actions are referentially stable, but each individual
    // useAppStore(s => s.someAction) still registers a subscription that React
    // must check on every store mutation. Consolidating 19 action refs into one
    // useShallow subscription means one equality check instead of 19.
    const actions = useAppStore(useShallow((s) => ({
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
        updateSettings: s.updateSettings,
        openNewWorkspacePage: s.openNewWorkspacePage
    })));
    const activeView = useAppStore((s) => s.activeView);
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
    const activeTabId = useAppStore((s) => s.activeTabId);
    const worktreesByRepo = useAppStore((s) => s.worktreesByRepo);
    const agentInputs = useAppStore(useShallow((s) => ({
        tabsByWorktree: s.tabsByWorktree,
        runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
        worktreesByRepo: s.worktreesByRepo
    })));
    const activeAgentCount = useMemo(() => countWorkingAgents(agentInputs), [agentInputs]);
    const workingAgentsPerWorktree = useMemo(() => getWorkingAgentsPerWorktree(agentInputs), [agentInputs]);
    const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId);
    const canExpandPaneByTabId = useAppStore((s) => s.canExpandPaneByTabId);
    const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady);
    const repos = useAppStore((s) => s.repos);
    const sidebarWidth = useAppStore((s) => s.sidebarWidth);
    const sidebarOpen = useAppStore((s) => s.sidebarOpen);
    const groupBy = useAppStore((s) => s.groupBy);
    const sortBy = useAppStore((s) => s.sortBy);
    const showActiveOnly = useAppStore((s) => s.showActiveOnly);
    const filterRepoIds = useAppStore((s) => s.filterRepoIds);
    const persistedUIReady = useAppStore((s) => s.persistedUIReady);
    const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth);
    const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen);
    const isFullScreen = useAppStore((s) => s.isFullScreen);
    const settings = useAppStore((s) => s.settings);
    const titlebarLeftControlsRef = useRef(null);
    const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0);
    // Subscribe to IPC push events
    useIpcEvents();
    // Why: git conflict-operation state also drives the worktree cards. Polling
    // cannot live under RightSidebar because App unmounts that subtree when the
    // sidebar is closed, which leaves stale "Rebasing"/"Merging" badges behind
    // until some unrelated view remount happens to refresh them.
    useGitStatusPolling();
    useGlobalFileDrop();
    // Fetch initial data + hydrate GitHub cache from disk
    useEffect(() => {
        let cancelled = false;
        // Why: AbortController must be declared outside the async block so the
        // cleanup function can abort it. Under StrictMode the effect runs twice;
        // without this, the first (unmounted) pass would keep spawning PTYs.
        const abortController = new AbortController();
        void (async () => {
            try {
                await actions.fetchRepos();
                await actions.fetchAllWorktrees();
                const persistedUI = await window.api.ui.get();
                const session = await window.api.session.get();
                if (!cancelled) {
                    actions.hydratePersistedUI(persistedUI);
                    actions.hydrateWorkspaceSession(session);
                    actions.hydrateTabsSession(session);
                    actions.hydrateEditorSession(session);
                    actions.hydrateBrowserSession(session);
                    await actions.fetchBrowserSessionProfiles();
                    await actions.fetchDetectedBrowsers();
                    await actions.reconnectPersistedTerminals(abortController.signal);
                    syncZoomCSSVar();
                }
            }
            catch (error) {
                console.error('Failed to hydrate workspace session:', error);
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
                        uiZoomLevel: 0,
                        editorFontZoomLevel: 0,
                        worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
                        statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
                        statusBarVisible: true,
                        dismissedUpdateVersion: null,
                        lastUpdateCheckAt: null
                    });
                    actions.hydrateWorkspaceSession({
                        activeRepoId: null,
                        activeWorktreeId: null,
                        activeTabId: null,
                        tabsByWorktree: {},
                        terminalLayoutsByTabId: {}
                    });
                    // Why: hydrateWorkspaceSession no longer sets workspaceSessionReady.
                    // The error path has no worktrees to reconnect, but must still flip
                    // the flag so auto-tab-creation and session writes are unblocked.
                    await actions.reconnectPersistedTerminals();
                }
            }
            void actions.fetchSettings();
            void actions.initGitHubCache();
        })();
        return () => {
            cancelled = true;
            abortController.abort();
        };
    }, [actions]);
    useEffect(() => {
        setRuntimeGraphStoreStateGetter(useAppStore.getState);
        return () => {
            setRuntimeGraphStoreStateGetter(null);
        };
    }, []);
    useEffect(() => registerUpdaterBeforeUnloadBypass(), []);
    useEffect(() => {
        setRuntimeGraphSyncEnabled(workspaceSessionReady);
        return () => {
            setRuntimeGraphSyncEnabled(false);
        };
    }, [workspaceSessionReady]);
    // Why: session persistence never drives JSX — it only writes to disk.
    // Using a Zustand subscribe() outside React removes ~15 subscriptions from
    // App's render cycle, eliminating re-renders on every tab/file/browser change.
    useEffect(() => {
        let timer = null;
        const unsub = useAppStore.subscribe((state) => {
            if (!state.workspaceSessionReady) {
                return;
            }
            if (timer) {
                window.clearTimeout(timer);
            }
            timer = window.setTimeout(() => {
                timer = null;
                void window.api.session.set(buildWorkspaceSessionPayload(state));
            }, 150);
        });
        return () => {
            unsub();
            if (timer) {
                window.clearTimeout(timer);
            }
        };
    }, []);
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
        let shutdownBuffersCaptured = false;
        const captureAndFlush = () => {
            if (shutdownBuffersCaptured) {
                return;
            }
            if (!useAppStore.getState().workspaceSessionReady) {
                return;
            }
            for (const capture of shutdownBufferCaptures) {
                try {
                    capture();
                }
                catch {
                    // Don't let one pane's failure block the rest.
                }
            }
            const state = useAppStore.getState();
            window.api.session.setSync(buildWorkspaceSessionPayload(state));
            shutdownBuffersCaptured = true;
        };
        window.addEventListener('beforeunload', captureAndFlush);
        return () => window.removeEventListener('beforeunload', captureAndFlush);
    }, []);
    // Periodically capture terminal scrollback buffers and persist to disk.
    // Why: the shutdown path captures buffers in beforeunload, but periodic
    // saves provide a safety net so scrollback is available on restart even
    // if an unexpected exit (crash, force-kill) bypasses normal shutdown.
    useEffect(() => {
        const PERIODIC_SAVE_INTERVAL_MS = 3 * 60_000;
        const timer = window.setInterval(() => {
            if (!useAppStore.getState().workspaceSessionReady || shutdownBufferCaptures.size === 0) {
                return;
            }
            for (const capture of shutdownBufferCaptures) {
                try {
                    capture();
                }
                catch {
                    // Don't let one pane's failure block the rest.
                }
            }
            const state = useAppStore.getState();
            void window.api.session.set(buildWorkspaceSessionPayload(state));
        }, PERIODIC_SAVE_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, []);
    useEffect(() => {
        if (!persistedUIReady) {
            return;
        }
        const timer = window.setTimeout(() => {
            void window.api.ui.set({
                sidebarWidth,
                rightSidebarWidth,
                groupBy,
                sortBy,
                showActiveOnly,
                filterRepoIds
            });
        }, 150);
        return () => window.clearTimeout(timer);
    }, [
        persistedUIReady,
        sidebarWidth,
        rightSidebarWidth,
        groupBy,
        sortBy,
        showActiveOnly,
        filterRepoIds
    ]);
    // Apply theme to document
    useEffect(() => {
        if (!settings) {
            return;
        }
        const applyTheme = (dark) => {
            document.documentElement.classList.toggle('dark', dark);
        };
        if (settings.theme === 'dark') {
            applyTheme(true);
            return undefined;
        }
        else if (settings.theme === 'light') {
            applyTheme(false);
            return undefined;
        }
        else {
            // system
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            applyTheme(mq.matches);
            const handler = (e) => applyTheme(e.matches);
            mq.addEventListener('change', handler);
            return () => mq.removeEventListener('change', handler);
        }
    }, [settings]);
    // Refresh GitHub data (PR/issue status) when window regains focus
    useEffect(() => {
        const handler = () => {
            if (document.visibilityState === 'visible') {
                actions.refreshAllGitHub();
            }
        };
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
    }, [actions]);
    const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : [];
    const hasTabBar = tabs.length >= 2;
    const effectiveActiveTabId = activeTabId ?? tabs[0]?.id ?? null;
    const activeTabCanExpand = effectiveActiveTabId
        ? (canExpandPaneByTabId[effectiveActiveTabId] ?? false)
        : false;
    const effectiveActiveTabExpanded = effectiveActiveTabId
        ? (expandedPaneByTabId[effectiveActiveTabId] ?? false)
        : false;
    const showTitlebarExpandButton = activeView === 'terminal' &&
        activeWorktreeId !== null &&
        !hasTabBar &&
        effectiveActiveTabExpanded;
    const showSidebar = activeView !== 'settings';
    // Why: when a worktree is active (split groups always enabled), the
    // full-width titlebar is replaced by a sidebar-width left header so the
    // terminal + tab groups extend to the very top of the window.
    const workspaceActive = activeView !== 'settings' && activeWorktreeId !== null;
    // Why: suppress right sidebar controls on new-workspace page since that
    // surface is intentionally distraction-free (no right sidebar).
    const showRightSidebarControls = activeView !== 'settings' && activeView !== 'new-workspace';
    const handleToggleExpand = () => {
        if (!effectiveActiveTabId) {
            return;
        }
        window.dispatchEvent(new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId: effectiveActiveTabId }
        }));
    };
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.repeat) {
                return;
            }
            // Why: child-component handlers (e.g. terminal search Cmd+G / Cmd+Shift+G)
            // register on the same window capture phase and fire first. If they already
            // called preventDefault, this handler must not also act on the event —
            // otherwise both actions execute (e.g. search navigation AND sidebar open).
            if (e.defaultPrevented) {
                return;
            }
            // Accept Cmd on macOS, Ctrl on other platforms
            const mod = isMac ? e.metaKey : e.ctrlKey;
            // Note: some app-level shortcuts are also intercepted via
            // before-input-event in createMainWindow.ts so they still work when a
            // browser guest has focus. The renderer keeps matching handlers for
            // local-focus cases and to preserve the same guards in one place.
            if (isEditableTarget(e.target)) {
                return;
            }
            if (!mod) {
                return;
            }
            // Cmd/Ctrl+B — toggle left sidebar
            if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
                dispatchClearModifierHints();
                e.preventDefault();
                actions.toggleSidebar();
                return;
            }
            // Why: the new-workspace composer should not be able to reveal the right
            // sidebar at all, because that surface is intentionally distraction-free.
            if (activeView === 'new-workspace') {
                return;
            }
            // Cmd/Ctrl+L — toggle right sidebar
            if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
                dispatchClearModifierHints();
                e.preventDefault();
                actions.toggleRightSidebar();
                return;
            }
            // Cmd/Ctrl+N — new workspace
            if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
                if (!repos.some((repo) => isGitRepoKind(repo))) {
                    return;
                }
                dispatchClearModifierHints();
                e.preventDefault();
                actions.openNewWorkspacePage();
                return;
            }
            // Cmd/Ctrl+Shift+E — toggle right sidebar / explorer tab
            if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
                dispatchClearModifierHints();
                e.preventDefault();
                actions.setRightSidebarTab('explorer');
                actions.setRightSidebarOpen(true);
                return;
            }
            // Cmd/Ctrl+Shift+F — toggle right sidebar / search tab
            if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
                dispatchClearModifierHints();
                e.preventDefault();
                actions.setRightSidebarTab('search');
                actions.setRightSidebarOpen(true);
                return;
            }
            // Cmd/Ctrl+Shift+G — toggle right sidebar / source control tab.
            // Skip when terminal search is open — Cmd+Shift+G means "find previous"
            // in that context (handled by keyboard-handlers.ts). Both listeners share
            // the window capture phase and registration order can vary with React
            // effect re-runs, so a DOM check is the reliable coordination mechanism.
            if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
                if (document.querySelector('[data-terminal-search-root]')) {
                    return;
                }
                dispatchClearModifierHints();
                e.preventDefault();
                actions.setRightSidebarTab('source-control');
                actions.setRightSidebarOpen(true);
            }
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [activeView, activeWorktreeId, actions, repos]);
    useLayoutEffect(() => {
        const controls = titlebarLeftControlsRef.current;
        if (!controls) {
            return;
        }
        const updateWidth = () => {
            setCollapsedSidebarHeaderWidth(controls.getBoundingClientRect().width);
        };
        updateWidth();
        const observer = new ResizeObserver(() => {
            updateWidth();
        });
        observer.observe(controls);
        return () => observer.disconnect();
    }, [
        activeAgentCount,
        isFullScreen,
        settings?.showTitlebarAgentActivity,
        showSidebar,
        workspaceActive,
        sidebarOpen
    ]);
    // Why: extracted so both the full-width titlebar (settings/landing) and
    // the sidebar-width left header (workspace view) can share the same
    // controls without duplicating the agent badge popover.
    const titlebarLeftControls = (_jsxs("div", { ref: titlebarLeftControlsRef, className: "flex h-full shrink-0 items-center", children: [_jsx("div", { className: isMac && !isFullScreen ? 'titlebar-traffic-light-pad' : 'pl-2' }), showSidebar && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { className: "sidebar-toggle", onClick: actions.toggleSidebar, "aria-label": "Toggle sidebar", children: _jsx(PanelLeft, { size: 16 }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: `Toggle sidebar (${isMac ? '⌘B' : 'Ctrl+B'})` })] })), settings?.showTitlebarAgentActivity !== false ? (_jsxs(Popover, { children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs("button", { className: `titlebar-agent-badge${activeAgentCount === 0 ? ' titlebar-agent-badge-idle' : ''}`, "aria-label": `${activeAgentCount} ${activeAgentCount === 1 ? 'agent' : 'agents'} active`, children: [_jsx("span", { className: `titlebar-agent-badge-dot${activeAgentCount === 0 ? ' titlebar-agent-badge-dot-idle' : ''}`, "aria-hidden": true }), _jsx("span", { className: "titlebar-agent-badge-count", children: activeAgentCount })] }) }), _jsxs(PopoverContent, { side: "bottom", sideOffset: 6, className: "titlebar-agent-hovercard", children: [_jsx("div", { className: `titlebar-agent-hovercard-header${activeAgentCount > 0 ? ' titlebar-agent-hovercard-header-with-list' : ''}`, children: activeAgentCount === 0
                                    ? 'No agents active'
                                    : `${activeAgentCount} ${activeAgentCount === 1 ? 'agent' : 'agents'} active` }), activeAgentCount > 0 && (_jsx("div", { className: "titlebar-agent-hovercard-list", children: Object.entries(workingAgentsPerWorktree).map(([worktreeId, { agents }]) => {
                                    const wt = findWorktreeById(worktreesByRepo, worktreeId);
                                    // Why: when a transient git error causes worktreesByRepo to
                                    // lose a worktree, the raw worktreeId (uuid::path) is not
                                    // useful. Extract a cross-platform path basename as a
                                    // readable fallback.
                                    const sepIdx = worktreeId.indexOf('::');
                                    const pathPart = sepIdx !== -1 ? worktreeId.slice(sepIdx + 2) : worktreeId;
                                    const fallbackName = pathPart.split(/[\\/]/).pop() || pathPart;
                                    return (_jsxs("div", { children: [_jsx("button", { className: "titlebar-agent-hovercard-worktree", onClick: () => {
                                                    // Why: if the worktree is missing from worktreesByRepo
                                                    // (transient git error cleared the list), refresh the
                                                    // repo's worktrees before navigating so the activation
                                                    // lookup succeeds instead of silently failing.
                                                    if (!wt) {
                                                        const repoId = getRepoIdFromWorktreeId(worktreeId);
                                                        void useAppStore
                                                            .getState()
                                                            .fetchWorktrees(repoId)
                                                            .then(() => {
                                                            activateAndRevealWorktree(worktreeId);
                                                        });
                                                        return;
                                                    }
                                                    activateAndRevealWorktree(worktreeId);
                                                }, children: _jsx("span", { className: "titlebar-agent-hovercard-name", children: wt?.displayName ?? fallbackName }) }), agents.map((agent, index) => (_jsxs("button", { className: "titlebar-agent-hovercard-agent", onClick: () => {
                                                    activateAndRevealWorktree(worktreeId);
                                                    useAppStore.getState().setActiveTab(agent.tabId);
                                                    if (agent.paneId !== null) {
                                                        // Why: a split-terminal tab can host multiple
                                                        // agents. After selecting the tab, wait one
                                                        // frame so the active TerminalPane can mount
                                                        // and then focus the specific pane the user
                                                        // clicked instead of leaving whichever pane
                                                        // was previously active highlighted.
                                                        requestAnimationFrame(() => {
                                                            window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_PANE_EVENT, {
                                                                detail: { tabId: agent.tabId, paneId: agent.paneId }
                                                            }));
                                                        });
                                                    }
                                                }, children: [_jsx("span", { className: "titlebar-agent-hovercard-agent-label", children: agent.label }), _jsx("span", { className: "titlebar-agent-hovercard-agent-dot" })] }, index)))] }, worktreeId));
                                }) })), _jsx("button", { className: "titlebar-agent-hovercard-hide", onClick: () => {
                                    void actions.updateSettings({ showTitlebarAgentActivity: false });
                                    toast('Agent activity badge hidden', {
                                        description: 'You can turn it back on in Settings → Appearance.',
                                        duration: Infinity,
                                        dismissible: true
                                    });
                                }, children: "Hide from titlebar" })] })] })) : null] }));
    const rightSidebarToggle = showRightSidebarControls ? (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { className: "sidebar-toggle mr-2", onClick: actions.toggleRightSidebar, "aria-label": "Toggle right sidebar", children: _jsx(PanelRight, { size: 16 }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: `Toggle right sidebar (${isMac ? '⌘L' : 'Ctrl+L'})` })] })) : null;
    useEffect(() => {
        if (activeView === 'new-workspace' && rightSidebarOpen) {
            // Why: hide the right sidebar immediately when entering the composer so
            // a previous open state can't bleed into the dedicated workspace flow.
            actions.setRightSidebarOpen(false);
        }
    }, [activeView, rightSidebarOpen, actions]);
    return (_jsxs("div", { className: "flex flex-col h-screen w-screen overflow-hidden", style: {
            '--collapsed-sidebar-header-width': `${collapsedSidebarHeaderWidth}px`
        }, children: [_jsxs(TooltipProvider, { delayDuration: 400, children: [!workspaceActive ? (_jsxs("div", { className: "titlebar", children: [_jsx("div", { className: `flex items-center${showSidebar && sidebarOpen ? ' overflow-hidden shrink-0' : ' shrink-0 mr-2'}`, style: { width: showSidebar && sidebarOpen ? sidebarWidth : undefined }, children: titlebarLeftControls }), _jsx("div", { id: "titlebar-tabs", className: `flex flex-1 min-w-0 self-stretch${activeView !== 'terminal' || !activeWorktreeId ? ' invisible pointer-events-none' : ''}` }), showTitlebarExpandButton && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { className: "titlebar-icon-button", onClick: handleToggleExpand, "aria-label": "Collapse pane", disabled: !activeTabCanExpand, children: _jsx(Minimize2, { size: 14 }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Collapse pane" })] })), rightSidebarToggle] })) : null, _jsxs("div", { className: "flex flex-row flex-1 min-h-0 overflow-hidden", children: [showSidebar ? (workspaceActive ? (
                            /* Why: left column wraps the sidebar with a titlebar-height
                               header above it. The header holds the same controls
                               (traffic lights, sidebar toggle, "Orca" title, agent badge)
                               that the full-width titlebar held while the center and right
                               columns keep their own top strips at the same 42px height.
                               When the sidebar is collapsed, take this header out of flex
                               layout so the terminal/editor reclaim the left edge instead of
                               leaving behind a content-width blank strip. */
                            _jsxs("div", { className: `flex min-h-0 flex-col shrink-0${sidebarOpen ? '' : ' relative w-0 overflow-visible'}`, children: [_jsx("div", { className: `titlebar-left${sidebarOpen ? '' : ' absolute top-0 left-0 z-10'}`, style: {
                                            // Why: the Sidebar resize hook updates the sidebar DOM width
                                            // directly during drag and only persists to Zustand on
                                            // mouseup. In workspace view, size this header from the
                                            // wrapper's live width so it tracks those in-flight resizes
                                            // instead of leaving a stale-width gap until the drag ends.
                                            width: sidebarOpen ? '100%' : undefined
                                        }, children: titlebarLeftControls }), _jsx("div", { className: "flex min-h-0 flex-1", children: _jsx(Sidebar, {}) })] })) : (_jsx(Sidebar, {}))) : null, _jsxs("div", { className: "relative flex flex-1 min-w-0 min-h-0 overflow-hidden", children: [workspaceActive && !rightSidebarOpen && (_jsx("div", { className: "absolute top-0 right-0 z-10 flex items-center h-[42px]", children: rightSidebarToggle })), _jsxs("div", { className: "flex flex-1 min-w-0 min-h-0 flex-col", children: [_jsx("div", { className: activeView !== 'terminal' || !activeWorktreeId
                                                    ? 'hidden flex-1 min-w-0 min-h-0'
                                                    : 'flex flex-1 min-w-0 min-h-0', children: _jsx(Terminal, {}) }), activeView === 'settings' ? _jsx(Settings, {}) : null, activeView === 'new-workspace' ? _jsx(NewWorkspacePage, {}) : null, activeView === 'terminal' && !activeWorktreeId ? _jsx(Landing, {}) : null] })] }), showRightSidebarControls ? _jsx(RightSidebar, {}) : null] }), _jsx(StatusBar, {}), _jsx(NewWorkspaceComposerModal, {})] }), _jsx(QuickOpen, {}), _jsx(WorktreeJumpPalette, {}), _jsx(UpdateCard, {}), _jsx(ZoomOverlay, {}), _jsx(SshPassphraseDialog, {}), _jsx(Toaster, { closeButton: true, toastOptions: { className: 'font-sans text-sm' } })] }));
}
export default App;
