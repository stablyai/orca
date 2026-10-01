import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

type StickyTitleTab = {
  type: string
  customTitle?: string | null
  parentTabId?: string
  leafId?: string
  ptyId?: string | null
}

type ManualTitlePty = {
  manualTitle?: string | null
}

type ManualTitleLeaf = {
  tabId: string
  leafId: string
  ptyId: string | null
}

export type StickyMobileTerminalTitle =
  | { kind: 'sticky'; title: string }
  | { kind: 'cleared' }
  | { kind: 'unset' }

function trimmedCustomTitle(title: string | null | undefined): string {
  return title?.trim() ?? ''
}

/**
 * A user rename outranks live OSC titles. `manualTitle` is the rename that
 * `terminal.rename` just applied and that the renderer snapshot has not echoed
 * yet. A snapshot `customTitle` is that echo, or a rename done on the desktop.
 * An explicit clear (`manualTitle === null`) hides a stale snapshot custom
 * title until the snapshot drops it.
 */
export function readStickyMobileTerminalTitle(
  tab: { customTitle?: string | null },
  pty: ManualTitlePty | null
): StickyMobileTerminalTitle {
  const manual = pty?.manualTitle
  if (typeof manual === 'string') {
    const trimmed = manual.trim()
    if (trimmed) {
      return { kind: 'sticky', title: trimmed }
    }
  }
  if (manual === null) {
    return { kind: 'cleared' }
  }
  const custom = trimmedCustomTitle(tab.customTitle)
  if (custom) {
    return { kind: 'sticky', title: custom }
  }
  return { kind: 'unset' }
}

function ptyForTerminalTab(
  tab: StickyTitleTab,
  ptysById: ReadonlyMap<string, ManualTitlePty>,
  leaves: Iterable<ManualTitleLeaf>
): ManualTitlePty | null {
  if (tab.ptyId) {
    const direct = ptysById.get(tab.ptyId)
    if (direct) {
      return direct
    }
  }
  if (!tab.parentTabId || !tab.leafId) {
    return null
  }
  for (const leaf of leaves) {
    if (leaf.tabId === tab.parentTabId && leaf.leafId === tab.leafId && leaf.ptyId) {
      return ptysById.get(leaf.ptyId) ?? null
    }
  }
  return null
}

/** Drop a pending rename once the stored snapshot carries that same custom title. */
export function releaseEchoedManualTerminalTitles(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  ptysById: ReadonlyMap<string, ManualTitlePty>,
  leaves: Iterable<ManualTitleLeaf>
): void {
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const pty = ptyForTerminalTab(tab, ptysById, leaves)
    if (!pty || pty.manualTitle === undefined) {
      continue
    }
    const custom = trimmedCustomTitle(tab.customTitle)
    if (typeof pty.manualTitle === 'string') {
      if (custom && custom === pty.manualTitle.trim()) {
        pty.manualTitle = undefined
      }
      continue
    }
    if (!custom) {
      pty.manualTitle = undefined
    }
  }
}
