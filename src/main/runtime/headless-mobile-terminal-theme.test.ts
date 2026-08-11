/**
 * A phone paired to `orca serve` or an SSH host never sees the renderer, so the
 * host terminal palette can only reach it if main stamps it onto every mobile
 * terminal tab it builds. There are three such builders, and the snapshot merge
 * keeps the FIRST tab per identity key — a pane created by an unstamped builder
 * would stay on the client fallback palette forever.
 */
import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'
const LEAF = '11111111-1111-4111-8111-111111111111'

const BASE_SETTINGS = {
  workspaceDir: '/tmp/workspaces',
  nestWorkspaces: false,
  refreshLocalBaseRefOnWorktreeCreate: false,
  branchPrefix: 'none',
  branchPrefixCustom: ''
}

function makeStore(settings: Record<string, unknown>) {
  const repo = {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const session: WorkspaceSessionState = {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  return {
    getRepo: () => repo,
    getRepos: () => [repo],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {},
    getSettings: () => ({ ...BASE_SETTINGS, ...settings })
  }
}

function makePersistedTerminalTab() {
  return {
    id: 'serve-tab',
    ptyId: 'serve-pty-1',
    worktreeId: WT,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

type RuntimeInternals = {
  buildHeadlessMobileSessionTerminalTabs: (
    worktreeId: string,
    persistedTabs: unknown[],
    session: WorkspaceSessionState
  ) => RuntimeMobileSessionTerminalTab[]
  publishPtyBackedMobileSessionTerminal: (
    worktreeId: string,
    pty: unknown,
    args: Record<string, unknown>
  ) => void
  createRuntimeOwnedMobileSessionTerminal: (
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts?: Record<string, unknown>
  ) => Promise<{ tab: RuntimeMobileSessionTerminalTab }>
  resolveTerminalWorkspaceLaunchScope: unknown
  resolveWorkspaceTerminalStartupCwd: unknown
  createTerminal: unknown
  getLivePtyForHandle: unknown
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

function hydrateTerminalTab(
  settings: Record<string, unknown>
): RuntimeMobileSessionTerminalTab | undefined {
  const store = makeStore(settings)
  const runtime = new OrcaRuntimeService(store)
  const session = store.getWorkspaceSession() as WorkspaceSessionState
  return (runtime as unknown as RuntimeInternals).buildHeadlessMobileSessionTerminalTabs(
    WT,
    [makePersistedTerminalTab()],
    session
  )[0]
}

describe('headless mobile terminal theme', () => {
  it('stamps the host palette onto hydrated terminal tabs', () => {
    expect(
      hydrateTerminalTab({ theme: 'dark', terminalThemeDark: 'Tokyo Night' })?.terminalTheme
    ).toMatchObject({ mode: 'dark', theme: { background: '#1a1b26' } })
  })

  it('resolves theme "system" to dark, matching a renderer with no matchMedia', () => {
    expect(hydrateTerminalTab({ theme: 'system' })?.terminalTheme?.mode).toBe('dark')
  })

  it('keeps the dark bias scoped to "system" so an explicit light host stays light', () => {
    expect(
      hydrateTerminalTab({
        theme: 'light',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'Builtin Tango Light'
      })?.terminalTheme
    ).toMatchObject({ mode: 'light', theme: { background: '#ffffff' } })
  })

  it('applies terminalColorOverrides and the background opacity conversion', () => {
    expect(
      hydrateTerminalTab({
        theme: 'dark',
        terminalColorOverrides: { background: '#f8f8f8' },
        terminalBackgroundOpacity: 0.8
      })?.terminalTheme?.theme.background
    ).toBe('rgba(248, 248, 248, 0.8)')
  })

  it('still builds the tab when the store exposes no terminal theme settings', () => {
    const tab = hydrateTerminalTab({})
    expect(tab?.parentTabId).toBe('serve-tab')
    expect(tab?.terminalTheme?.mode).toBe('dark')
  })

  it('omits terminalTheme entirely when the runtime has no store', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    internals.publishPtyBackedMobileSessionTerminal(
      WT,
      { ptyId: 'pty-1', launchAgent: null, foregroundAgent: null, title: 'Terminal' },
      { tabId: 'tab-1', leafId: LEAF, title: 'Terminal', activate: true }
    )
    const tab = internals.mobileSessionTabsByWorktree.get(WT)?.tabs[0]
    expect(tab?.type).toBe('terminal')
    expect(tab).not.toHaveProperty('terminalTheme')
  })

  it('stamps the host palette on a PTY-backed publication (rescue / split)', () => {
    const runtime = new OrcaRuntimeService(
      makeStore({ theme: 'dark', terminalThemeDark: 'Tokyo Night' })
    )
    const internals = runtime as unknown as RuntimeInternals
    internals.publishPtyBackedMobileSessionTerminal(
      WT,
      { ptyId: 'pty-1', launchAgent: null, foregroundAgent: null, title: 'Terminal' },
      { tabId: 'tab-1', leafId: LEAF, title: 'Terminal', activate: true }
    )
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabs[0]).toMatchObject({
      type: 'terminal',
      terminalTheme: { mode: 'dark', theme: { background: '#1a1b26' } }
    })
  })

  it('stamps the host palette on the phone-initiated new terminal', async () => {
    const runtime = new OrcaRuntimeService(
      makeStore({ theme: 'dark', terminalThemeDark: 'Tokyo Night' })
    )
    const internals = runtime as unknown as RuntimeInternals
    internals.resolveTerminalWorkspaceLaunchScope = async () => ({
      id: WT,
      path: '/tmp/worktree-a',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    internals.resolveWorkspaceTerminalStartupCwd = () => '/tmp/worktree-a'
    internals.createTerminal = async () => ({ handle: 'handle-1', title: 'Terminal' })
    internals.getLivePtyForHandle = () => ({
      record: {},
      pty: { ptyId: 'pty-1', tabId: 'tab-1', paneKey: `tab-1:${LEAF}`, title: 'Terminal' }
    })

    const created = await internals.createRuntimeOwnedMobileSessionTerminal(WT, true)
    expect(created.tab.terminalTheme).toMatchObject({
      mode: 'dark',
      theme: { background: '#1a1b26' }
    })
  })

  it('re-resolves the host palette on a settings-only change between hydrates', () => {
    // Why: resolveRuntimeMobileTerminalTheme keys on the settings object (and the
    // renderer cache compares state.settings identity). A palette rename must not
    // stick to a prior projection when only settings changed.
    const tokyo = hydrateTerminalTab({ theme: 'dark', terminalThemeDark: 'Tokyo Night' })
    const ghostty = hydrateTerminalTab({
      theme: 'dark',
      terminalThemeDark: 'Ghostty Default Style Dark'
    })
    expect(tokyo?.terminalTheme?.theme.background).toBe('#1a1b26')
    expect(ghostty?.terminalTheme?.theme.background).not.toBe(
      tokyo?.terminalTheme?.theme.background
    )
  })

})
