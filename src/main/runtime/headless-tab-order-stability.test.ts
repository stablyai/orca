import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'

const WT = 'repo-1::/home/orca/worktree'
const GROUP = `headless-terminals:${WT}`

const terminalTab = (n: number, isActive = false): RuntimeMobileSessionTerminalTab => ({
  type: 'terminal',
  id: `tab-${n}::leaf-${n}`,
  title: `terminal ${n}`,
  parentTabId: `tab-${n}`,
  leafId: `leaf-${n}`,
  ptyId: `pty-${n}`,
  isActive
})

const snapshotOf = (
  tabs: RuntimeMobileSessionSnapshotTab[],
  tabOrder: string[],
  activeTabId: string | null
): RuntimeMobileSessionTabsSnapshot => ({
  worktree: WT,
  publicationEpoch: 'headless:seed',
  snapshotVersion: 1,
  activeGroupId: GROUP,
  activeTabId,
  activeTabType: 'terminal',
  tabGroups: [{ id: GROUP, activeTabId: activeTabId?.split('::')[0] ?? null, tabOrder }],
  tabs
})

describe('headless tab order stability', () => {
  it('retains order when activating a re-appended surface', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      activateHeadlessMobileSessionTerminalTab: (
        worktreeId: string,
        snapshot: RuntimeMobileSessionTabsSnapshot,
        activeTab: RuntimeMobileSessionTerminalTab
      ) => void
      emitMobileSessionTabsSnapshot: (snapshot: RuntimeMobileSessionTabsSnapshot) => void
      persistHeadlessTerminalActiveLeaf: (...args: unknown[]) => void
    }
    runtime.emitMobileSessionTabsSnapshot = () => {}
    runtime.persistHeadlessTerminalActiveLeaf = () => {}

    const tabs = [terminalTab(1), terminalTab(3), terminalTab(4), terminalTab(2, true)]
    const snapshot = snapshotOf(tabs, ['tab-1', 'tab-2', 'tab-3', 'tab-4'], 'tab-2::leaf-2')
    runtime.mobileSessionTabsByWorktree.set(WT, snapshot)

    runtime.activateHeadlessMobileSessionTerminalTab(WT, snapshot, tabs[3]!)

    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroups?.[0]?.tabOrder).toEqual([
      'tab-1',
      'tab-2',
      'tab-3',
      'tab-4'
    ])
  })

  it('retains stored order when a materialized surface is re-appended', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      mergeMobileSessionTabGroups: (
        worktreeId: string,
        groups: { id: string; activeTabId: string | null; tabOrder: string[] }[],
        terminalTabs: RuntimeMobileSessionTerminalTab[],
        activeTab: RuntimeMobileSessionTerminalTab | null
      ) => { id: string; tabOrder: string[] }[]
    }
    const reappended = [terminalTab(1), terminalTab(3), terminalTab(4), terminalTab(2, true)]
    const merged = runtime.mergeMobileSessionTabGroups(
      WT,
      [{ id: GROUP, activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-2', 'tab-3', 'tab-4'] }],
      reappended,
      reappended[3]!
    )
    expect(merged[0]!.tabOrder).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
  })

  it('appends only genuinely new tabs after retained order', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      mergeMobileSessionTabGroups: (
        worktreeId: string,
        groups: { id: string; activeTabId: string | null; tabOrder: string[] }[],
        terminalTabs: RuntimeMobileSessionTerminalTab[],
        activeTab: RuntimeMobileSessionTerminalTab | null
      ) => { id: string; tabOrder: string[] }[]
    }
    const tabs = [terminalTab(3), terminalTab(1), terminalTab(5, true)]
    const merged = runtime.mergeMobileSessionTabGroups(
      WT,
      [{ id: GROUP, activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-2', 'tab-3'] }],
      tabs,
      tabs[2]!
    )
    expect(merged[0]!.tabOrder).toEqual(['tab-1', 'tab-3', 'tab-5'])
  })

  it('retains order independently in split groups', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      buildHeadlessMobileSessionTabGroups: (
        worktreeId: string,
        tabs: RuntimeMobileSessionSnapshotTab[],
        activeTab: RuntimeMobileSessionSnapshotTab | null,
        existingGroups?: RuntimeMobileSessionTabsSnapshot['tabGroups']
      ) => RuntimeMobileSessionTabsSnapshot['tabGroups']
    }
    const tabs = [terminalTab(2), terminalTab(1), terminalTab(4), terminalTab(3)]
    const groups = runtime.buildHeadlessMobileSessionTabGroups(WT, tabs, tabs[0]!, [
      { id: 'left', activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-2'] },
      { id: 'right', activeTabId: 'tab-3', tabOrder: ['tab-3', 'tab-4'] }
    ])
    expect(groups?.find((group) => group.id === 'left')?.tabOrder).toEqual(['tab-1', 'tab-2'])
    expect(groups?.find((group) => group.id === 'right')?.tabOrder).toEqual(['tab-3', 'tab-4'])
  })
})
