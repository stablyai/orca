import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'

const WT = 'repo-1::/home/gal/dev/orca'
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
  tabs: RuntimeMobileSessionTerminalTab[],
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
  it('keeps the user tab order when a materialized surface is re-appended to the tabs array', () => {
    // Four tabs the user arranged as 1,2,3,4. Clicking an idle tab makes the host
    // materialize its PTY, and every publish path that re-publishes a surface drops it
    // from the tabs array and pushes it back on the end -- here, tab 2.
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
    const seeded = snapshotOf(tabs, ['tab-1', 'tab-2', 'tab-3', 'tab-4'], 'tab-2::leaf-2')
    runtime.mobileSessionTabsByWorktree.set(WT, seeded)

    runtime.activateHeadlessMobileSessionTerminalTab(WT, seeded, tabs[3]!)

    const next = runtime.mobileSessionTabsByWorktree.get(WT)!
    expect(next.tabGroups![0]!.tabOrder).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
  })

  it('does not rotate the order across a sequence of activations', () => {
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

    runtime.mobileSessionTabsByWorktree.set(
      WT,
      snapshotOf(
        [terminalTab(1, true), terminalTab(2), terminalTab(3), terminalTab(4)],
        ['tab-1', 'tab-2', 'tab-3', 'tab-4'],
        'tab-1::leaf-1'
      )
    )

    // Click 3, then 2, then 4 -- each click materializes and re-appends that surface.
    for (const n of [3, 2, 4]) {
      const current = runtime.mobileSessionTabsByWorktree.get(WT)!
      const target = current.tabs.find(
        (tab): tab is RuntimeMobileSessionTerminalTab =>
          tab.type === 'terminal' && tab.parentTabId === `tab-${n}`
      )!
      // The re-append the publish paths perform before the group rebuild runs.
      const reappended: RuntimeMobileSessionTabsSnapshot = {
        ...current,
        tabs: [...current.tabs.filter((tab) => tab.id !== target.id), target]
      }
      runtime.mobileSessionTabsByWorktree.set(WT, reappended)
      runtime.activateHeadlessMobileSessionTerminalTab(WT, reappended, target)
    }

    const next = runtime.mobileSessionTabsByWorktree.get(WT)!
    expect(next.tabGroups![0]!.tabOrder).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
  })

  it('keeps the stored order when merging a re-appended surface into existing groups', () => {
    // The second order builder, used by the PTY-backed publish path.
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

  it('appends a genuinely new tab at the end', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      mergeMobileSessionTabGroups: (
        worktreeId: string,
        groups: { id: string; activeTabId: string | null; tabOrder: string[] }[],
        terminalTabs: RuntimeMobileSessionTerminalTab[],
        activeTab: RuntimeMobileSessionTerminalTab | null
      ) => { id: string; tabOrder: string[] }[]
    }

    const withNew = [terminalTab(1), terminalTab(2), terminalTab(5, true)]
    const merged = runtime.mergeMobileSessionTabGroups(
      WT,
      [{ id: GROUP, activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-2'] }],
      withNew,
      withNew[2]!
    )

    expect(merged[0]!.tabOrder).toEqual(['tab-1', 'tab-2', 'tab-5'])
  })
})
