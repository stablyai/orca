import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeSnapshotTab(
  overrides: Partial<RuntimeMobileSessionTerminalTab> = {}
): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal',
    id: `${TAB_ID}::${LEAF_ID}`,
    parentTabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'Terminal',
    isActive: true,
    ...overrides
  }
}

function makeSnapshot(tabs: RuntimeMobileSessionTerminalTab[]): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'repo1::/path/wt1',
    publicationEpoch: 'headless-hydrated:test',
    snapshotVersion: 1,
    activeGroupId: 'g1',
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'g1', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
    tabs
  }
}

function makeHost(
  overrides: Partial<RuntimeMobileSessionProjectionHost> = {}
): RuntimeMobileSessionProjectionHost {
  const emptyPty = null
  return {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => undefined,
    getProviderSessionSnapshot: () => [],
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    findPty: () => emptyPty,
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    issuePtyHandle: () => '',
    recordPty: () => ({}) as RuntimePtyWorktreeRecord,
    buildPtyStatus: () => ({}),
    sanitizeGroups: (groups) => groups,
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set(),
    ...overrides
  }
}

function project(
  tabs: RuntimeMobileSessionTerminalTab[],
  hostOverrides: Partial<RuntimeMobileSessionProjectionHost> = {}
): RuntimeMobileSessionTerminalTab[] {
  const result = projectRuntimeMobileSessionTabs(makeSnapshot(tabs), makeHost(hostOverrides))
  return result.tabs.filter((tab) => tab.type === 'terminal') as RuntimeMobileSessionTerminalTab[]
}

describe('projectRuntimeMobileSessionTabs customTitle priority', () => {
  it('a persisted customTitle beats a fresh OSC leaf title', () => {
    const leaf = {
      ptyId: 'pty-1',
      connected: true,
      paneTitle: 'Claude working',
      paneTitleUpdatedAt: 10,
      lastOscTitle: 'Claude working',
      lastOscTitleAt: 10
    } as unknown as RuntimeLeafRecord
    const projected = project([makeSnapshotTab({ customTitle: 'my rename' })], {
      leaves: new Map([[`${TAB_ID}:${LEAF_ID}`, leaf]])
    })
    expect(projected[0]!.title).toBe('my rename')
    expect(projected[0]!.customTitle).toBe('my rename')
  })

  it('a persisted customTitle beats the tracked PTY title', () => {
    const projected = project([makeSnapshotTab({ customTitle: 'my rename' })], {
      getTrackedTitle: () => 'Codex working'
    })
    expect(projected[0]!.title).toBe('my rename')
  })

  it('does not normalize a manual rename that looks like an agent title', () => {
    // A manual rename matching the legacy π shape must survive verbatim.
    const leaf = {
      ptyId: 'pty-1',
      connected: true,
      paneTitle: 'π > session - repo',
      paneTitleUpdatedAt: 10,
      lastOscTitle: 'π > session - repo',
      lastOscTitleAt: 10
    } as unknown as RuntimeLeafRecord
    const projected = project([makeSnapshotTab({ customTitle: 'π > session - repo' })], {
      leaves: new Map([[`${TAB_ID}:${LEAF_ID}`, leaf]])
    })
    expect(projected[0]!.title).toBe('π > session - repo')
    expect(projected[0]!.customTitle).toBe('π > session - repo')
  })

  it('without customTitle, the OSC leaf title still wins', () => {
    const leaf = {
      ptyId: 'pty-1',
      connected: true,
      paneTitle: 'Claude working',
      paneTitleUpdatedAt: 10,
      lastOscTitle: 'Claude working',
      lastOscTitleAt: 10
    } as unknown as RuntimeLeafRecord
    const projected = project([makeSnapshotTab()], {
      leaves: new Map([[`${TAB_ID}:${LEAF_ID}`, leaf]])
    })
    expect(projected[0]!.title).toBe('Claude working')
    expect(projected[0]!.customTitle).toBeUndefined()
  })

  it('falls back to snapshot tab title when no rename and no observations', () => {
    const projected = project([makeSnapshotTab({ title: 'Terminal 2' })])
    expect(projected[0]!.title).toBe('Terminal 2')
  })
})
