import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const WORKTREE = 'repo-1::/workspace'

function terminal(
  overrides: Partial<RuntimeMobileSessionTerminalTab> = {}
): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal',
    id: `tab-1::${LEAF}`,
    parentTabId: 'tab-1',
    leafId: LEAF,
    title: 'Radar',
    isActive: true,
    ...overrides
  }
}

function snapshot(tab = terminal()): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'renderer-test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tab.id,
    activeTabType: 'terminal',
    tabs: [tab]
  }
}

function host(trackedTitle: string | null = 'Cowork'): RuntimeMobileSessionProjectionHost {
  return {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => [],
    getProviderSessionSnapshot: () => [],
    getStatusSnapshot: () => [],
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    findPty: () => null,
    getRetainedStatus: () => null,
    getTrackedTitle: () => trackedTitle,
    getTitleDisplayClear: () => null,
    issuePtyHandle: () => {
      throw new Error('fixture has no live PTY')
    },
    recordPty: () => {
      throw new Error('fixture has no live PTY')
    },
    buildPtyStatus: () => ({}),
    sanitizeGroups: () => undefined,
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  }
}

function persistedTab(customTitle: string | null = 'Radar'): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: WORKTREE,
    ptyId: null,
    title: 'Cowork',
    customTitle,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function session(tab: TerminalTab): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    activeTabId: tab.id,
    tabsByWorktree: { [WORKTREE]: [tab] },
    terminalLayoutsByTabId: {
      [tab.id]: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    }
  }
}

describe('mobile explicit terminal title', () => {
  it('keeps a manual rename ahead of later tracker titles without changing session identity', () => {
    const tab = terminal({ customTitle: 'Radar' })
    for (const title of ['Cowork', 'Codex working', 'Done']) {
      const result = projectRuntimeMobileSessionTabs(snapshot(tab), host(title))
      expect(result.tabs[0]).toMatchObject({
        title: 'Radar',
        id: tab.id,
        parentTabId: 'tab-1',
        leafId: LEAF,
        status: 'pending-handle',
        terminal: null
      })
      expect(result.tabs[0]).not.toHaveProperty('customTitle')
    }
  })

  it('preserves an explicit title verbatim instead of rebranding it as an agent status', () => {
    const result = projectRuntimeMobileSessionTabs(
      snapshot(terminal({ customTitle: 'OMP ready', launchAgent: 'pi' })),
      host('Cowork')
    )
    expect(result.tabs[0]?.title).toBe('OMP ready')
  })

  it.each([undefined, null, '  '])(
    'keeps legacy behavior when optional metadata is %s',
    (customTitle) => {
      expect(
        projectRuntimeMobileSessionTabs(snapshot(terminal({ customTitle })), host()).tabs[0]?.title
      ).toBe('Cowork')
    }
  )

  it('restores live titles after clearing a rename', () => {
    const renamed = terminal({ customTitle: 'Radar' })
    expect(projectRuntimeMobileSessionTabs(snapshot(renamed), host()).tabs[0]?.title).toBe('Radar')
    expect(
      projectRuntimeMobileSessionTabs(snapshot({ ...renamed, customTitle: null }), host()).tabs[0]
        ?.title
    ).toBe('Cowork')
  })

  it('does not require a mobile upgrade: the reply retains the existing title field and handle shape', () => {
    const result = JSON.parse(
      JSON.stringify(
        projectRuntimeMobileSessionTabs(snapshot(terminal({ customTitle: 'Закупки' })), host())
      )
    )
    expect(result.tabs[0].title).toBe('Закупки')
    expect(result.tabs[0].type).toBe('terminal')
    expect(result.tabs[0].status).toBe('pending-handle')
    expect(result.tabs[0].terminal).toBeNull()
  })

  it('retains explicit rename provenance through headless reconstruction after restart', () => {
    const tab = persistedTab()
    const rebuilt = buildHeadlessMobileSessionTerminalTabs(WORKTREE, [tab], session(tab))
    expect(rebuilt[0]).toMatchObject({ title: 'Radar', customTitle: 'Radar' })
    expect(
      projectRuntimeMobileSessionTabs(
        { ...snapshot(), publicationEpoch: 'headless-test', tabs: rebuilt },
        host()
      ).tabs[0]?.title
    ).toBe('Radar')
  })

  it('does not propagate a parent nickname to unrelated split leaves', () => {
    const tab = persistedTab()
    const state = session(tab)
    state.terminalLayoutsByTabId[tab.id] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF },
        second: { type: 'leaf', leafId: OTHER_LEAF }
      },
      activeLeafId: LEAF,
      expandedLeafId: null
    }
    const rebuilt = buildHeadlessMobileSessionTerminalTabs(WORKTREE, [tab], state)
    expect(rebuilt).toHaveLength(2)
    for (const pane of rebuilt) {
      expect(pane).not.toHaveProperty('customTitle')
    }
  })
})
