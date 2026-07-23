import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer startup runtime routing', () => {
  it('hydrates persisted UI before local catalog and worktree hydration', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const startupBlockStart = source.indexOf('void (async () => {')
    // Why: concurrent startup branches all settle before hydrate-session-stores.
    const startupBlockEnd = source.indexOf("timeRendererStartupSyncStep('hydrate-session-stores'")
    const startupBlock = source.slice(startupBlockStart, startupBlockEnd)

    const indexInStartupBlock = (needle: string): number => {
      const relativeIndex = startupBlock.indexOf(needle)
      return relativeIndex === -1 ? -1 : startupBlockStart + relativeIndex
    }
    const settingsIndex = indexInStartupBlock('actions.fetchSettings()')
    const uiGetIndex = indexInStartupBlock("timeRendererStartupStep('ui-get'")
    const hydrateUiIndex = indexInStartupBlock("timeRendererStartupSyncStep('hydrate-persisted-ui'")
    const localReposIndex = indexInStartupBlock(
      "actions.fetchReposForAllHosts({ remoteHosts: 'skip' })"
    )
    const localGroupsIndex = indexInStartupBlock(
      "actions.fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })"
    )
    const localFoldersIndex = indexInStartupBlock(
      "actions.fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })"
    )
    const sessionIndex = indexInStartupBlock("timeRendererStartupStep('session-get'")
    const hydrationWorktreesIndex = source.indexOf(
      "timeRendererStartupStep('fetch-hydration-worktrees'"
    )
    const fullWorktreesIndex = source.indexOf('await actions.fetchAllWorktrees()')
    const lineageIndex = startupBlock.indexOf('actions.fetchWorktreeLineage()')

    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(startupBlockEnd).toBeGreaterThan(startupBlockStart)
    // Persisted UI hydrates before any local catalog/session/worktree read kicks off.
    expect(settingsIndex).toBeLessThan(uiGetIndex)
    expect(uiGetIndex).toBeLessThan(hydrateUiIndex)
    expect(hydrateUiIndex).toBeLessThan(localReposIndex)
    // The local catalog chain stays internally ordered (folders merge against project groups).
    expect(localReposIndex).toBeLessThan(localGroupsIndex)
    expect(localGroupsIndex).toBeLessThan(localFoldersIndex)
    expect(localReposIndex).toBeLessThan(sessionIndex)
    expect(sessionIndex).toBeLessThan(hydrationWorktreesIndex)
    const hydrationWorktreeBlock = source.slice(
      hydrationWorktreesIndex,
      source.indexOf('await keybindingsPromise')
    )
    expect(hydrationWorktreeBlock).toContain(
      'mapWithConcurrency(hydrationRepos, WORKTREE_REFRESH_CONCURRENCY'
    )
    expect(hydrationWorktreeBlock).toContain('executionHostId: getRepoExecutionHostId(repo)')
    // Why: the pre-hydration fetch must include SSH repos (only runtime-owned repos are
    // excluded); gating on local-only drops SSH tab/editor/browser chrome at hydration.
    const hydrationFilterBlock = source.slice(
      source.indexOf('const hydrationRepos'),
      hydrationWorktreesIndex
    )
    expect(hydrationFilterBlock).toContain(
      "parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'"
    )
    expect(hydrationFilterBlock).not.toContain('=== LOCAL_EXECUTION_HOST_ID')
    expect(fullWorktreesIndex).toBeGreaterThan(
      source.indexOf("logRendererStartupDiagnostic('startup-hydration-done'")
    )
    // Why: the deferred full scan must be followed by a re-prune so deleted-worktree visit
    // timestamps for non-session repos are dropped once every repo is authoritative.
    expect(
      source.indexOf('actions.pruneLastVisitedTimestamps()', fullWorktreesIndex)
    ).toBeGreaterThan(fullWorktreesIndex)
    expect(lineageIndex).toBe(-1)

    // The catalog and selective hydration chains overlap, but both settle before recovery or hydration.
    const joinStart = indexInStartupBlock('await Promise.allSettled([')
    expect(joinStart).toBeGreaterThan(hydrateUiIndex)
    const joinBlock = source.slice(joinStart, startupBlockEnd)
    expect(joinBlock).toContain('hydrationSessionChain')
    expect(joinBlock).toContain('localCatalogChain')
    expect(startupBlock).not.toContain('await Promise.all([')
    expect(startupBlock).not.toContain("actions.fetchAllWorktrees({ hydrationPurge: 'defer' })")
  })

  it('refreshes remote catalogs after startup hydration succeeds', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const hydrationDoneIndex = source.indexOf(
      "logRendererStartupDiagnostic('startup-hydration-done'"
    )
    const remoteCatalogIndex = source.indexOf("timeRendererStartupStep('remote-catalog-refresh'")
    const remoteWorktreeIndex = source.indexOf("timeRendererStartupStep('remote-worktree-refresh'")
    const remoteCatalogFailureIndex = source.indexOf(
      "console.warn('Remote startup catalog refresh failed:'"
    )
    const lineageIndex = source.indexOf('actions.fetchWorktreeLineage()')
    const startupRefreshCompletedIndex = source.indexOf('startupWorktreeRefreshCompleted: true')

    expect(hydrationDoneIndex).toBeGreaterThanOrEqual(0)
    expect(hydrationDoneIndex).toBeLessThan(remoteCatalogIndex)
    expect(remoteCatalogIndex).toBeLessThan(remoteCatalogFailureIndex)
    // Why: a project-group/folder catalog failure must not suppress the independent full worktree scan.
    expect(remoteCatalogFailureIndex).toBeLessThan(remoteWorktreeIndex)
    expect(remoteWorktreeIndex).toBeLessThan(lineageIndex)
    expect(lineageIndex).toBeLessThan(startupRefreshCompletedIndex)
    expect(source.slice(remoteCatalogIndex, remoteWorktreeIndex)).toContain(
      'actions.fetchReposForAllHosts()'
    )

    const startupFailureIndex = source.indexOf(
      '[startup] Workspace session hydration failed; leaving disk state untouched:'
    )
    expect(startupFailureIndex).toBeGreaterThanOrEqual(0)
    expect(
      source.indexOf('startupWorktreeRefreshCompleted: true', startupFailureIndex)
    ).toBeGreaterThan(startupFailureIndex)
    expect(source.slice(remoteCatalogIndex, remoteWorktreeIndex)).toContain(
      'actions.fetchProjectGroupsForAllHosts()'
    )
    expect(source.slice(remoteCatalogIndex, remoteWorktreeIndex)).toContain(
      'actions.fetchFolderWorkspacesForAllHosts()'
    )
  })

  it('waits for first-window startup services before terminal reconnect', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const reconnectIndex = source.indexOf('await actions.reconnectPersistedTerminals')
    const servicesIndex = source.indexOf('await window.api.app.awaitFirstWindowStartupServices()')

    expect(servicesIndex).toBeGreaterThanOrEqual(0)
    expect(servicesIndex).toBeLessThan(reconnectIndex)
  })

  it('keeps the persisted Automations view from starting its own bootstrap worktree scan', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/automations/AutomationsPage.tsx'),
      'utf8'
    )
    const fullRefreshStart = source.indexOf('const mountedBeforeStartupWorktreeRefreshRef')
    const fullRefreshEffect = source.slice(
      fullRefreshStart,
      source.indexOf('void refresh()', fullRefreshStart)
    )

    expect(fullRefreshEffect).toContain('if (!startupWorktreeRefreshCompleted)')
    expect(fullRefreshEffect).toContain('mountedBeforeStartupWorktreeRefreshRef.current')
    expect(fullRefreshEffect).toContain('void fetchAllWorktrees()')
  })

  it('does not eagerly import the floating terminal panel on startup', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain(
      "import { FloatingTerminalToggleButton } from './components/floating-terminal/FloatingTerminalToggleButton'"
    )
    expect(source).toContain("import('./components/floating-terminal/FloatingTerminalPanel').then")
    expect(source).not.toContain("from './components/floating-terminal/FloatingTerminalPanel'")
  })

  it('does not eagerly import idle optional overlay surfaces on startup', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain("import('./components/UpdateCard').then")
    expect(source).toContain("import('./components/contextual-tours/ContextualTourOverlay').then")
    expect(source).toContain("import('./components/setup-guide/SetupGuideTelemetryObserver').then")
    expect(source).not.toContain("from './components/UpdateCard'")
    expect(source).not.toContain("from './components/contextual-tours/ContextualTourOverlay'")
    expect(source).not.toContain("from './components/setup-guide/SetupGuideTelemetryObserver'")
    expect(source).toContain('const shouldMountSetupGuideTelemetryObserver = persistedUIReady')
    expect(source).not.toContain(
      "const shouldMountSetupGuideTelemetryObserver = persistedUIReady && activeModal === 'setup-guide'"
    )
  })

  it('keeps crash-report listeners eager while lazy-loading the dialog surface', () => {
    const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const hostSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/crash-report/CrashReportDialog.tsx'),
      'utf8'
    )

    expect(appSource).toContain(
      "import { CrashReportDialog } from './components/crash-report/CrashReportDialog'"
    )
    expect(appSource).not.toContain("from './components/crash-report/CrashReportDialogSurface'")
    expect(hostSource).toContain("import('./CrashReportDialogSurface').then")
    expect(hostSource).toContain('window.api.crashReports.getLatestPending()')
    expect(hostSource).toContain('window.api.ui.onOpenCrashReport')
    expect(hostSource).toContain('REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT')
    expect(hostSource).toContain('if (!open) {')
    expect(hostSource).not.toContain('if (!open && !loading)')
  })

  it('clears stale crash-report state before opening the lazy manual report surface', () => {
    const hostSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/crash-report/CrashReportDialog.tsx'),
      'utf8'
    )
    const manualOpenStart = hostSource.indexOf('return window.api.ui.onOpenCrashReport(() => {')
    const manualOpenEnd = hostSource.indexOf('  }, [loadCrashReport])', manualOpenStart)
    const manualOpenBlock = hostSource.slice(manualOpenStart, manualOpenEnd)

    expect(manualOpenBlock.indexOf('setReport(null)')).toBeGreaterThanOrEqual(0)
    expect(manualOpenBlock.indexOf('setReport(null)')).toBeLessThan(
      manualOpenBlock.indexOf('setOpen(true)')
    )
    expect(manualOpenBlock.indexOf('setReport(null)')).toBeLessThan(
      manualOpenBlock.indexOf('loadCrashReport(false)')
    )
  })

  it('loads dictation only when voice is enabled or a session is active', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain("import('./components/dictation/DictationController').then")
    expect(source).not.toContain("from './components/dictation/DictationController'")
    expect(source).toContain("settings?.voice?.enabled === true || dictationState !== 'idle'")
    expect(source).toContain('shouldMountDictationController ?')
  })

  it('loads the SSH passphrase dialog only when a credential request is queued', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain("import('./components/settings/SshPassphraseDialog').then")
    expect(source).not.toContain("from './components/settings/SshPassphraseDialog'")
    expect(source).toContain('s.sshCredentialQueue.length > 0')
    expect(source).toContain('hasSshCredentialRequest ?')
  })

  it('defers background polling until the workspace session is ready', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain('useGitStatusPolling({ enabled: workspaceSessionReady })')
    expect(source).toContain('<WorkspacePortScanner enabled={workspaceSessionReady} />')
  })

  it('does not load the terminal workbench on the no-workspace landing path', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain("const Terminal = lazy(() => import('./components/Terminal'))")
    expect(source).not.toContain("from './components/Terminal'")
    expect(source).toContain('const hasMountedTerminalWorkbenchRef = useRef(false)')
    expect(source).toContain('hasMountedTerminalWorkbenchRef.current = true')
    expect(source).toContain('activeWorktreeId !== null || backgroundTerminalMountRequested')
    expect(source).toContain('backgroundTerminalMountRequested ||')
    expect(source).toContain('hasMountedTerminalWorkbenchRef.current')
    expect(source).toContain('shouldMountTerminalWorkbench ?')
  })

  it('keeps the new-workspace composer eager because it is a critical create surface', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const lazyModalSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/lazy-modal-mount-state.ts'),
      'utf8'
    )

    expect(source).toContain(
      "import NewWorkspaceComposerModal from './components/NewWorkspaceComposerModal'"
    )
    expect(source).not.toContain("import('./components/NewWorkspaceComposerModal')")
    expect(source).toContain("activeModal === 'new-workspace-composer'")
    expect(lazyModalSource).not.toContain("'new-workspace-composer'")
  })

  it('does not eagerly import inactive sidebar dialog flows on startup', () => {
    const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const sidebarSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/sidebar/index.tsx'),
      'utf8'
    )

    expect(appSource).toContain("lazy(() => import('./components/sidebar/AddRepoDialog'))")
    expect(appSource).toContain("lazy(() => import('./components/sidebar/NonGitFolderDialog'))")
    expect(appSource).toContain("import('./components/sidebar/AddProjectFromFolderDialog')")
    expect(appSource).toContain("lazy(() => import('./components/sidebar/ProjectAddedDialog'))")
    expect(appSource).toContain("activeModal === 'add-repo'")
    expect(appSource).toContain("activeModal === 'confirm-non-git-folder'")
    expect(appSource).toContain("activeModal === 'confirm-add-project-from-folder'")
    expect(appSource).toContain("activeModal === 'project-added'")
    expect(appSource).toContain('shouldMountAddRepoDialog ? (')
    expect(appSource).toContain('boundaryId="modal.add-repo"')
    expect(appSource).toContain('boundaryId="modal.confirm-non-git-folder"')
    expect(appSource).toContain('boundaryId="modal.confirm-add-project-from-folder"')
    expect(appSource).toContain('boundaryId="modal.project-added"')
    expect(appSource).toContain('setTimeout(() =>')
    expect(sidebarSource).toContain("lazyWithRetry(() => import('./WorktreeMetaDialog'))")
    expect(sidebarSource).not.toContain("from './AddRepoDialog'")
    expect(sidebarSource).not.toContain("React.lazy(() => import('./AddRepoDialog'))")
    expect(sidebarSource).not.toContain("React.lazy(() => import('./NonGitFolderDialog'))")
    expect(sidebarSource).not.toContain("React.lazy(() => import('./AddProjectFromFolderDialog'))")
    expect(sidebarSource).not.toContain("React.lazy(() => import('./ProjectAddedDialog'))")
    expect(sidebarSource).not.toContain('shouldMountAddRepoDialog ? <AddRepoDialog /> : null')
    expect(sidebarSource).not.toContain(
      "activeModal === 'confirm-non-git-folder' ? <NonGitFolderDialog /> : null"
    )
    expect(sidebarSource).not.toContain(
      "activeModal === 'confirm-add-project-from-folder' ? <AddProjectFromFolderDialog /> : null"
    )
    expect(sidebarSource).not.toContain(
      "activeModal === 'project-added' ? <ProjectAddedDialog /> : null"
    )
    expect(sidebarSource).toContain("activeModal === 'edit-meta' ? <WorktreeMetaDialog /> : null")
    expect(sidebarSource).toContain(
      "activeModal === 'confirm-remove-folder' ? <RemoveFolderDialog /> : null"
    )
  })

  it('does not eagerly import optional status-bar segments on startup', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/status-bar/StatusBar.tsx'),
      'utf8'
    )

    expect(source).toContain("import('./ResourceUsageStatusSegment').then")
    expect(source).toContain("import('./PortsStatusSegment').then")
    expect(source).toContain("import('./SshStatusSegment').then")
    expect(source).toContain("import('./PetStatusSegment').then")
    expect(source).not.toContain("from './ResourceUsageStatusSegment'")
    expect(source).not.toContain("from './PortsStatusSegment'")
    expect(source).not.toContain("from './SshStatusSegment'")
    expect(source).not.toContain("from './PetStatusSegment'")
  })

  it('does not eagerly import the status bar shell on startup', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).toContain("import('./components/status-bar/StatusBar').then")
    expect(source).not.toContain("from './components/status-bar/StatusBar'")
    expect(source).toContain('statusBarVisible ? (')
    expect(source).toContain('h-6 min-h-[24px] shrink-0 border-t border-border')
  })

  it('keeps activeView off the 150ms debounced UI writer hot path (#9002)', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const writerStart = source.indexOf('const timer = window.setTimeout(() => {')
    const writerEnd = source.indexOf('}, 150)', writerStart)
    const writerBlock = source.slice(writerStart, writerEnd)

    expect(writerStart).toBeGreaterThanOrEqual(0)
    expect(writerEnd).toBeGreaterThan(writerStart)
    // Why: this field riding the writer's payload (#8265) is exactly the
    // #9002 regression — every switch scheduled a full durable-state save. It
    // must persist through its narrow preference or unload path instead. Matched as
    // a standalone object-literal property (not the surrounding prose, which
    // legitimately references the field name) so the assertion is precise.
    expect(writerBlock).not.toMatch(/^\s*activeView,\s*$/m)

    const depsStart = source.indexOf('}, [', writerEnd)
    const depsEnd = source.indexOf('])', depsStart)
    const depsBlock = source.slice(depsStart, depsEnd)
    expect(depsBlock).not.toMatch(/^\s*activeView,?\s*$/m)
  })

  it('persists activeView through its narrow preference on every switch (#9002)', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    const preferenceEffect = [
      '// Why (#9002): activeView has its own tiny profile preference',
      'void window.api.ui.set({ activeView })',
      '}, [activeView, persistedUIReady])'
    ]
    for (const marker of preferenceEffect) {
      expect(source).toContain(marker)
    }
    expect(source).not.toContain('createActiveViewIdleFlush')
    expect(source).not.toContain("window.addEventListener('blur', handleBlur)")
  })

  it('checkpoints activeView and all session snapshots through one beforeunload handler (#9002)', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const checkpointStart = source.indexOf(
      'const shutdownCheckpoint = createShutdownCheckpointGuard(() => {'
    )
    const checkpointEnd = source.indexOf(
      'const persistBeforeUnload = createShutdownCheckpointBeforeUnloadHandler(shutdownCheckpoint)',
      checkpointStart
    )
    expect(checkpointStart).toBeGreaterThanOrEqual(0)
    expect(checkpointEnd).toBeGreaterThan(checkpointStart)
    const checkpointBlock = source.slice(checkpointStart, checkpointEnd)

    expect(checkpointBlock).toContain('const sessionSnapshots = shouldCaptureSession')
    expect(checkpointBlock).toContain(
      'buildWorkspaceSessionHostSnapshots(buildWorkspaceSessionPayload(freshState), freshState)'
    )
    expect(checkpointBlock).toContain('window.api.app.persistBeforeUnloadSync({')
    expect(checkpointBlock).toContain('sessions: sessionSnapshots')
    expect(checkpointBlock).toContain('ui: buildActiveViewUnloadPatch(freshState)')
    expect(source).toContain(
      'window.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)'
    )
    expect(source).toContain(
      'window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)'
    )
    expect(source).toContain("window.addEventListener('beforeunload', persistBeforeUnload)")
    expect(source.match(/window\.addEventListener\('beforeunload'/g) ?? []).toHaveLength(1)
    expect(source).not.toContain('window.api.ui.setSync')
  })
})
