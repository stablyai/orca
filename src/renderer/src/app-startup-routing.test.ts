import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer startup runtime routing', () => {
  it('loads settings before repo and worktree hydration', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const startupBlockStart = source.indexOf('void (async () => {')
    const startupBlockEnd = source.indexOf('const persistedUI = await window.api.ui.get()')
    const startupBlock = source.slice(startupBlockStart, startupBlockEnd)

    expect(startupBlock.indexOf('await actions.fetchSettings()')).toBeGreaterThanOrEqual(0)
    expect(startupBlock.indexOf('await actions.fetchSettings()')).toBeLessThan(
      startupBlock.indexOf('await actions.fetchRepos()')
    )
    expect(startupBlock.indexOf('await actions.fetchSettings()')).toBeLessThan(
      startupBlock.indexOf('await actions.fetchAllWorktrees()')
    )
  })

  it('waits for first-window startup services before terminal reconnect', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const reconnectIndex = source.indexOf('await actions.reconnectPersistedTerminals')
    const servicesIndex = source.indexOf('await window.api.app.awaitFirstWindowStartupServices()')

    expect(servicesIndex).toBeGreaterThanOrEqual(0)
    expect(servicesIndex).toBeLessThan(reconnectIndex)
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
    expect(source).toContain('activeWorktreeId !== null || hasMountedTerminalWorkbenchRef.current')
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
    expect(sidebarSource).toContain("React.lazy(() => import('./WorktreeMetaDialog'))")
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
})
