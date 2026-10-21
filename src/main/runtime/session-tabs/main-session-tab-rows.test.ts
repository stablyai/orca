import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { withMainSessionTabRows, type MainSessionTabRows } from './main-session-tab-rows'

const WT = 'repo::/wt'
const NONE_EXITED = (): boolean => false

function terminal(
  id: string,
  extra: Partial<RuntimeMobileSessionTerminalTab> = {}
): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal' as const,
    id,
    title: 'Terminal',
    parentTabId: id.split('::')[0]!,
    leafId: id.split('::')[1]!,
    isActive: false,
    ...extra
  }
}

function file(id: string, mode: 'edit' | 'diff' = 'edit') {
  return {
    type: 'file' as const,
    id,
    title: id,
    filePath: `/wt/${id}`,
    relativePath: id,
    language: 'typescript',
    mode,
    isDirty: false,
    isActive: false
  }
}

function browser(id: string) {
  return {
    type: 'browser' as const,
    id,
    title: 'Page',
    browserWorkspaceId: id,
    browserPageId: null,
    url: 'https://example.com',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

function windowSnapshot(
  tabs: RuntimeMobileSessionSnapshotTab[],
  tabOrder: string[],
  activeTabId: string | null
): RuntimeMobileSessionTabsSnapshot {
  const active = tabs.find((tab) => tab.id === activeTabId)
  return {
    worktree: WT,
    publicationEpoch: 'renderer',
    snapshotVersion: 7,
    activeGroupId: 'g',
    activeTabId,
    activeTabType: active?.type ?? null,
    tabGroups: [{ id: 'g', activeTabId, tabOrder }],
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId }))
  }
}

function mainProjection(
  tabs: RuntimeMobileSessionSnapshotTab[],
  tabOrder: string[],
  activeTabId: string | null
): MainSessionTabRows {
  const {
    publicationEpoch: _e,
    snapshotVersion: _v,
    ...rest
  } = windowSnapshot(tabs, tabOrder, activeTabId)
  return rest
}

describe('session.tabs rows from main (layout-owner build, before D3b)', () => {
  it("takes main's terminal rows and name, with the window's theme, status and draft", () => {
    const theme = { mode: 'dark' as const, theme: {} }
    const agentStatus = null
    const merged = withMainSessionTabRows(
      windowSnapshot(
        [
          terminal('t::a', {
            title: 'Old',
            customTitle: 'Old',
            terminalTheme: theme,
            agentStatus,
            launchDraft: 'ls'
          })
        ],
        ['t'],
        't::a'
      ),
      mainProjection(
        [terminal('t::a', { title: 'Renamed', customTitle: 'Renamed' }), terminal('t::b')],
        ['t'],
        't::a'
      ),
      NONE_EXITED
    )

    expect(merged.publicationEpoch).toBe('renderer')
    expect(merged.snapshotVersion).toBe(7)
    expect(merged.tabs).toEqual([
      terminal('t::a', {
        title: 'Renamed',
        customTitle: 'Renamed',
        terminalTheme: theme,
        agentStatus,
        launchDraft: 'ls',
        isActive: true
      }),
      terminal('t::b')
    ])
  })

  it('keeps the rows main does not hold (browser, diff) in the window’s place', () => {
    const merged = withMainSessionTabRows(
      windowSnapshot(
        [terminal('t::a'), browser('b1'), file('d1', 'diff'), file('f1')],
        ['t', 'b1', 'd1', 'f1'],
        't::a'
      ),
      mainProjection([terminal('t::a'), browser('b1'), file('f1')], ['t', 'b1', 'f1'], 't::a'),
      NONE_EXITED
    )

    expect(merged.tabs.map((tab) => tab.id)).toEqual(['t::a', 'b1', 'd1', 'f1'])
    expect(merged.tabGroups?.[0]?.tabOrder).toEqual(['t', 'b1', 'd1', 'f1'])
  })

  // #30569: a closed editor leaves no stale active id behind.
  it('drops an editor main closed, and its stale active id, though the window still lists it', () => {
    const merged = withMainSessionTabRows(
      windowSnapshot([terminal('t::a'), file('f1')], ['t', 'f1'], 'f1'),
      mainProjection([terminal('t::a')], ['t'], 't::a'),
      NONE_EXITED
    )

    expect(merged.tabs.map((tab) => tab.id)).toEqual(['t::a'])
    expect(merged).toMatchObject({ activeTabId: 't::a', activeTabType: 'terminal' })
    expect(merged.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['t::a'])
    expect(merged.tabGroups?.[0]?.tabOrder).toEqual(['t'])
  })

  it("keeps the window's selection while it shows a row main does not list", () => {
    const merged = withMainSessionTabRows(
      windowSnapshot([terminal('t::a'), file('d1', 'diff')], ['t', 'd1'], 'd1'),
      mainProjection([terminal('t::a')], ['t'], 't::a'),
      NONE_EXITED
    )

    expect(merged).toMatchObject({ activeTabId: 'd1', activeTabType: 'file' })
    expect(merged.tabGroups?.[0]?.activeTabId).toBe('d1')
    expect(merged.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['d1'])
  })

  it('moves the window-selected row of a group main lacks into a group, and selects that group', () => {
    const published: RuntimeMobileSessionTabsSnapshot = {
      ...windowSnapshot([terminal('t::a'), file('d1', 'diff')], ['t'], 'd1'),
      activeGroupId: 'g2',
      tabGroups: [
        { id: 'g', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'd1', tabOrder: ['d1'] }
      ]
    }
    const merged = withMainSessionTabRows(
      published,
      mainProjection([terminal('t::a')], ['t'], 't::a'),
      NONE_EXITED
    )

    expect(merged.tabGroups).toEqual([{ id: 'g', activeTabId: 'd1', tabOrder: ['t', 'd1'] }])
    expect(merged).toMatchObject({ activeGroupId: 'g', activeTabId: 'd1' })
  })

  it("takes the window's live selection, focused pane and dirty state, not main's saved view", () => {
    const merged = withMainSessionTabRows(
      windowSnapshot(
        [terminal('t::a'), terminal('t::b', { title: 'vim' }), { ...file('f1'), isDirty: true }],
        ['t', 'f1'],
        't::b'
      ),
      mainProjection([terminal('t::a'), terminal('t::b'), file('f1')], ['t', 'f1'], 't::a'),
      NONE_EXITED
    )

    expect(merged).toMatchObject({ activeTabId: 't::b', activeTabType: 'terminal' })
    expect(merged.tabGroups?.[0]?.activeTabId).toBe('t')
    expect(merged.tabs.find((tab) => tab.id === 't::b')).toMatchObject({ title: 'vim' })
    expect(merged.tabs.find((tab) => tab.id === 'f1')).toMatchObject({ isDirty: true })
  })

  it("keeps main's selection while the window selects a pane main has not drawn yet", () => {
    const merged = withMainSessionTabRows(
      windowSnapshot([terminal('t::a'), terminal('t::new')], ['t'], 't::new'),
      mainProjection([terminal('t::a')], ['t'], 't::a'),
      NONE_EXITED
    )

    expect(merged).toMatchObject({ activeTabId: 't::a' })
    expect(merged.tabs.map((tab) => tab.id)).toEqual(['t::a'])
  })

  it("lets main's cleared binding win over the window's id of a terminal main saw exit", () => {
    const published = windowSnapshot([terminal('t::a', { ptyId: 'pty-gone' })], ['t'], 't::a')
    const projected = mainProjection([terminal('t::a')], ['t'], 't::a')

    expect(
      withMainSessionTabRows(published, projected, (id) => id === 'pty-gone').tabs[0]
    ).not.toHaveProperty('ptyId')
    // Not seen exiting (an SSH restore before its terminal registers): listed pending under it.
    expect(withMainSessionTabRows(published, projected, NONE_EXITED).tabs[0]).toMatchObject({
      ptyId: 'pty-gone'
    })
  })

  it('puts a window-only row of a group main lacks into the active group, not the first', () => {
    const published: RuntimeMobileSessionTabsSnapshot = {
      ...windowSnapshot([terminal('t::a'), terminal('u::a'), browser('b1')], ['t'], 'u::a'),
      activeGroupId: 'g2',
      tabGroups: [
        { id: 'g', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'u', tabOrder: ['u'] },
        { id: 'g3', activeTabId: 'b1', tabOrder: ['b1'] }
      ]
    }
    const projected: MainSessionTabRows = {
      ...mainProjection([terminal('t::a'), terminal('u::a')], ['t'], 't::a'),
      tabGroups: [
        { id: 'g', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'u', tabOrder: ['u'] }
      ]
    }

    const merged = withMainSessionTabRows(published, projected, NONE_EXITED)

    expect(merged.tabGroups).toEqual([
      { id: 'g', activeTabId: 't', tabOrder: ['t'] },
      { id: 'g2', activeTabId: 'u', tabOrder: ['u', 'b1'] }
    ])
    expect(merged).toMatchObject({ activeGroupId: 'g2', activeTabId: 'u::a' })
  })

  it("keeps each group's shown tab as main has it while main's selection stands", () => {
    const merged = withMainSessionTabRows(
      windowSnapshot([terminal('t::a'), terminal('t::new'), file('f1')], ['t', 'f1'], 't::new'),
      mainProjection([terminal('t::a'), file('f1')], ['t', 'f1'], 'f1'),
      NONE_EXITED
    )

    expect(merged).toMatchObject({ activeTabId: 'f1', activeTabType: 'file' })
    expect(merged.tabGroups?.[0]?.activeTabId).toBe('f1')
    expect(merged.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['f1'])
  })

  it("puts a stray row the window selects into main's active group", () => {
    const published: RuntimeMobileSessionTabsSnapshot = {
      ...windowSnapshot([terminal('t::a'), terminal('u::a'), browser('b1')], ['t'], 'b1'),
      activeGroupId: 'g3',
      tabGroups: [
        { id: 'g', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'u', tabOrder: ['u'] },
        { id: 'g3', activeTabId: 'b1', tabOrder: ['b1'] }
      ]
    }
    const projected: MainSessionTabRows = {
      ...mainProjection([terminal('t::a'), terminal('u::a')], ['t'], 'u::a'),
      activeGroupId: 'g2',
      tabGroups: [
        { id: 'g', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'u', tabOrder: ['u'] }
      ]
    }

    const merged = withMainSessionTabRows(published, projected, NONE_EXITED)

    expect(merged.tabGroups?.[1]).toEqual({ id: 'g2', activeTabId: 'b1', tabOrder: ['u', 'b1'] })
    expect(merged).toMatchObject({ activeGroupId: 'g2', activeTabId: 'b1' })
  })

  it("takes a markdown edit view's dirty state from the window", () => {
    const markdown = (isDirty: boolean) => ({
      type: 'markdown' as const,
      id: 'm1',
      title: 'README.md',
      filePath: '/wt/README.md',
      relativePath: 'README.md',
      language: 'markdown' as const,
      mode: 'edit' as const,
      sourceFileId: '/wt/README.md',
      sourceFilePath: '/wt/README.md',
      sourceRelativePath: 'README.md',
      documentVersion: 'file:/wt/README.md',
      isDirty,
      isActive: false
    })
    const merged = withMainSessionTabRows(
      windowSnapshot([markdown(true)], ['m1'], 'm1'),
      mainProjection([markdown(false)], ['m1'], 'm1'),
      NONE_EXITED
    )

    expect(merged.tabs[0]).toMatchObject({ id: 'm1', isDirty: true })
  })
})
