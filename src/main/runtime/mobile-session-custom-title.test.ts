import { expect, it, vi } from 'vitest'
import {
  readStickyMobileTerminalTitle,
  releaseEchoedManualTerminalTitles
} from './mobile-session-custom-title'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

function projectTitle(args: {
  customTitle?: string
  manualTitle?: string | null
  oscTitle?: string
  trackedTitle?: string | null
  snapshotTitle?: string
}): string {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: projection reads the title fields this fixture sets.
  const pty = {
    ptyId: 'live-pty',
    connected: true,
    manualTitle: args.manualTitle,
    title: null,
    titleUpdatedAt: null,
    lastOscTitle: null,
    lastOscTitleAt: null
  } as RuntimePtyWorktreeRecord
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: projection reads pane and OSC titles off the leaf.
  const leaf = {
    tabId: 'tab',
    leafId: 'leaf',
    ptyId: pty.ptyId,
    connected: true,
    paneTitle: null,
    paneTitleUpdatedAt: null,
    lastOscTitle: args.oscTitle ?? null,
    lastOscTitleAt: args.oscTitle ? 50 : null
  } as RuntimeLeafRecord
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every host member this title path calls.
  const host = {
    tabs: new Map(),
    leaves: new Map([['leaf', leaf]]),
    ptysById: new Map([[pty.ptyId, pty]]),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => [],
    getProviderSessionSnapshot: () => [],
    getLeafKey: () => 'leaf',
    findPty: () => null,
    getRetainedStatus: () => null,
    getTrackedTitle: () => args.trackedTitle ?? null,
    getTitleDisplayClear: () => null,
    issuePtyHandle: vi.fn(() => 'handle'),
    recordPty: vi.fn(() => pty),
    buildPtyStatus: () => ({}),
    sanitizeGroups: () => [],
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  } as unknown as RuntimeMobileSessionProjectionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one terminal tab is the only snapshot field this title path reads.
  const snapshot = {
    worktree: 'workspace',
    publicationEpoch: 'desktop:epoch',
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        parentTabId: 'tab',
        leafId: 'leaf',
        ptyId: pty.ptyId,
        title: args.snapshotTitle ?? 'Shell',
        ...(args.customTitle ? { customTitle: args.customTitle } : {}),
        isActive: true
      }
    ]
  } as RuntimeMobileSessionTabsSnapshot
  const tab = projectRuntimeMobileSessionTabs(snapshot, host).tabs[0]
  if (tab?.type !== 'terminal') {
    throw new Error('expected a terminal tab')
  }
  return tab.title
}

it('keeps a desktop custom title ahead of a live OSC title', () => {
  expect(
    projectTitle({
      customTitle: 'Ship notes',
      oscTitle: 'Codex working',
      trackedTitle: 'Codex spinning'
    })
  ).toBe('Ship notes')
})

it('keeps a pending mobile rename ahead of the snapshot custom title', () => {
  expect(
    projectTitle({
      customTitle: 'Old mac name',
      manualTitle: 'Ship notes',
      oscTitle: 'Codex working'
    })
  ).toBe('Ship notes')
})

it('keeps publishing OSC titles when nobody has renamed the tab', () => {
  expect(projectTitle({ oscTitle: 'Codex working', snapshotTitle: 'Shell' })).toBe('Codex working')
})

it('hides a stale snapshot custom title after an explicit clear', () => {
  expect(
    projectTitle({
      customTitle: 'Ship notes',
      manualTitle: null,
      oscTitle: 'Codex working',
      snapshotTitle: 'Ship notes'
    })
  ).toBe('Codex working')
})

it('shows a tracked title while an explicit clear waits for the snapshot', () => {
  expect(
    projectTitle({
      customTitle: 'Ship notes',
      manualTitle: null,
      oscTitle: 'Codex working',
      trackedTitle: 'Codex spinning',
      snapshotTitle: 'Ship notes'
    })
  ).toBe('Codex spinning')
})

function releaseFixture(customTitle?: string): {
  pty: { manualTitle?: string | null; manualTitleBaseline?: string }
  tabs: { type: string; ptyId: string; customTitle?: string | null }[]
  snapshot: RuntimeMobileSessionTabsSnapshot
} {
  const pty: { manualTitle?: string | null; manualTitleBaseline?: string } = {}
  const tabs: { type: string; ptyId: string; customTitle?: string | null }[] = [
    { type: 'terminal', ptyId: 'pty-1', ...(customTitle ? { customTitle } : {}) }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only tab type, pty id, and custom title.
  const snapshot = { tabs } as unknown as RuntimeMobileSessionTabsSnapshot
  return { pty, tabs, snapshot }
}

it('releases a pending rename only when the snapshot echoes that name', () => {
  const { pty, tabs, snapshot } = releaseFixture('Old mac name')
  pty.manualTitle = 'Ship notes'
  const ptys = new Map([['pty-1', pty]])

  releaseEchoedManualTerminalTitles(snapshot, ptys, [])
  expect(pty.manualTitle).toBe('Ship notes')
  expect(readStickyMobileTerminalTitle(tabs[0], pty)).toEqual({
    kind: 'sticky',
    title: 'Ship notes'
  })

  tabs[0] = { type: 'terminal', ptyId: 'pty-1', customTitle: 'Ship notes' }
  releaseEchoedManualTerminalTitles(snapshot, ptys, [])
  expect(pty.manualTitle).toBeUndefined()
  expect(readStickyMobileTerminalTitle(tabs[0], pty)).toEqual({
    kind: 'sticky',
    title: 'Ship notes'
  })
})

it('drops an explicit clear once the snapshot no longer carries a custom title', () => {
  const { pty, tabs, snapshot } = releaseFixture('Ship notes')
  pty.manualTitle = null

  releaseEchoedManualTerminalTitles(snapshot, new Map([['pty-1', pty]]), [])
  expect(pty.manualTitle).toBeNull()

  tabs[0] = { type: 'terminal', ptyId: 'pty-1' }
  releaseEchoedManualTerminalTitles(snapshot, new Map([['pty-1', pty]]), [])
  expect(pty.manualTitle).toBeUndefined()
})

it('keeps a split rename until a later desktop custom title arrives', () => {
  const { pty, tabs, snapshot } = releaseFixture()
  pty.manualTitle = 'Phone name'
  pty.manualTitleBaseline = ''
  const ptys = new Map([['pty-1', pty]])

  releaseEchoedManualTerminalTitles(snapshot, ptys, [])
  expect(pty.manualTitle).toBe('Phone name')

  tabs[0] = { type: 'terminal', ptyId: 'pty-1', customTitle: 'Desktop name' }
  releaseEchoedManualTerminalTitles(snapshot, ptys, [])
  expect(pty.manualTitle).toBeUndefined()
  expect(readStickyMobileTerminalTitle(tabs[0], pty)).toEqual({
    kind: 'sticky',
    title: 'Desktop name'
  })
})

it('does not let the custom title from rename time erase the phone name', () => {
  const { pty, tabs, snapshot } = releaseFixture('Old mac name')
  pty.manualTitle = 'Phone name'
  pty.manualTitleBaseline = 'Old mac name'
  const ptys = new Map([['pty-1', pty]])

  releaseEchoedManualTerminalTitles(snapshot, ptys, [])
  expect(pty.manualTitle).toBe('Phone name')

  tabs[0] = { type: 'terminal', ptyId: 'pty-1', customTitle: 'Desktop name' }
  releaseEchoedManualTerminalTitles(snapshot, ptys, [])
  expect(pty.manualTitle).toBeUndefined()
})

it('drops an explicit clear when the desktop publishes a different custom title', () => {
  const { pty, tabs, snapshot } = releaseFixture('Old mac name')
  pty.manualTitle = null
  pty.manualTitleBaseline = 'Old mac name'

  releaseEchoedManualTerminalTitles(snapshot, new Map([['pty-1', pty]]), [])
  expect(pty.manualTitle).toBeNull()

  tabs[0] = { type: 'terminal', ptyId: 'pty-1', customTitle: 'Desktop name' }
  releaseEchoedManualTerminalTitles(snapshot, new Map([['pty-1', pty]]), [])
  expect(pty.manualTitle).toBeUndefined()
  expect(readStickyMobileTerminalTitle(tabs[0], pty)).toEqual({
    kind: 'sticky',
    title: 'Desktop name'
  })
})

const LEFT_LEAF = '11111111-1111-4111-8111-111111111111'
const RIGHT_LEAF = '22222222-2222-4222-8222-222222222222'

function persistedTab(customTitle: string): TerminalTab {
  return {
    id: 'host-tab',
    ptyId: 'pty-parent',
    worktreeId: 'workspace',
    title: 'Parent title',
    customTitle,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

it('does not copy a parent custom title onto headless split leaves', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads the layout and the active tab id.
  const session = {
    activeTabId: 'host-tab',
    activeTabIdByWorktree: { workspace: 'host-tab' },
    terminalLayoutsByTabId: {
      'host-tab': {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT_LEAF },
          second: { type: 'leaf', leafId: RIGHT_LEAF }
        },
        activeLeafId: LEFT_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT_LEAF]: 'pty-left', [RIGHT_LEAF]: 'pty-right' },
        titlesByLeafId: { [LEFT_LEAF]: 'left pane', [RIGHT_LEAF]: 'right pane' }
      }
    }
  } as unknown as WorkspaceSessionState
  const tabs = buildHeadlessMobileSessionTerminalTabs(
    'workspace',
    [persistedTab('Pinned name')],
    session
  )
  expect(tabs.map((tab) => tab.title)).toEqual(['left pane', 'right pane'])
  expect(tabs.map((tab) => tab.customTitle)).toEqual([undefined, undefined])
})

it('keeps a parent custom title on a single headless leaf', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads the layout and the active tab id.
  const session = {
    activeTabId: 'host-tab',
    activeTabIdByWorktree: { workspace: 'host-tab' },
    terminalLayoutsByTabId: {
      'host-tab': {
        root: { type: 'leaf', leafId: LEFT_LEAF },
        activeLeafId: LEFT_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT_LEAF]: 'pty-left' }
      }
    }
  } as unknown as WorkspaceSessionState
  const tabs = buildHeadlessMobileSessionTerminalTabs(
    'workspace',
    [persistedTab('Pinned name')],
    session
  )
  expect(tabs.map((tab) => tab.title)).toEqual(['Pinned name'])
  expect(tabs.map((tab) => tab.customTitle)).toEqual(['Pinned name'])
})
