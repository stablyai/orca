import { normalizeCompatibleAgentTitleForOwner } from '../../shared/agent-title-owner'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimeTerminalRename } from '../../shared/runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  getLatestAgentCandidateTitle,
  getLeafDisplayRecord,
  getPtyDisplayRecord,
  type TitleDisplayClear
} from './runtime-worktree-status-projection'

type StickyTitleTab = {
  type: string
  customTitle?: string | null
  parentTabId?: string
  leafId?: string
  ptyId?: string | null
}

type ManualTitlePty = {
  manualTitle?: string | null
  /** Snapshot custom title observed when the pending rename was armed. */
  manualTitleBaseline?: string
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
 * title until the snapshot drops it or replaces it.
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

export function projectedLeafOscTitle(
  leaf: RuntimeLeafRecord,
  clear: TitleDisplayClear | null
): string | null {
  const display = getLeafDisplayRecord(leaf, clear)
  return getLatestAgentCandidateTitle(
    { title: display.paneTitle, updatedAt: display.paneTitleUpdatedAt },
    { title: display.lastOscTitle, updatedAt: display.lastOscTitleAt }
  )
}

export function projectedPtyOscTitle(
  pty: RuntimePtyWorktreeRecord,
  clear: TitleDisplayClear | null
): string | null {
  const display = getPtyDisplayRecord(pty, clear)
  return getLatestAgentCandidateTitle(
    { title: display.title, updatedAt: display.titleUpdatedAt },
    { title: display.lastOscTitle, updatedAt: display.lastOscTitleAt }
  )
}

/** Mobile strip title: a user rename, then a clear, then the live OSC chain. */
export function projectStickyMobileTerminalTitle(input: {
  tab: { customTitle?: string | null; title: string }
  pty: ManualTitlePty | null
  trackerOnlyTitle: string | null
  oscTitle: string | null
  syncedTitle: string | null | undefined
  ownerAgent: Parameters<typeof normalizeCompatibleAgentTitleForOwner>[1]
  ownerOptions: Parameters<typeof normalizeCompatibleAgentTitleForOwner>[2]
}): string {
  const sticky = readStickyMobileTerminalTitle(input.tab, input.pty)
  const fallback =
    sticky.kind === 'sticky'
      ? sticky.title
      : sticky.kind === 'cleared'
        ? (input.trackerOnlyTitle ?? input.oscTitle ?? 'Terminal')
        : (input.trackerOnlyTitle ?? input.oscTitle ?? input.syncedTitle ?? input.tab.title)
  return sticky.kind === 'sticky'
    ? fallback
    : normalizeCompatibleAgentTitleForOwner(fallback, input.ownerAgent, input.ownerOptions)
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

/** Custom title already published for this PTY. `''` means the snapshot leaf has
 *  none. `undefined` means the tab is not in a snapshot yet. */
export function observedManualTitleBaseline(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  ptyId: string | null,
  leaves: Iterable<ManualTitleLeaf>
): string | undefined {
  if (!snapshot || !ptyId) {
    return undefined
  }
  const leafList = [...leaves]
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    let ownsPty = tab.ptyId === ptyId
    if (!ownsPty && tab.parentTabId && tab.leafId) {
      ownsPty = leafList.some(
        (leaf) =>
          leaf.ptyId === ptyId && leaf.tabId === tab.parentTabId && leaf.leafId === tab.leafId
      )
    }
    if (!ownsPty) {
      continue
    }
    return typeof tab.customTitle === 'string' ? tab.customTitle.trim() : ''
  }
  return undefined
}

function releasePendingManualTitle(pty: ManualTitlePty): void {
  pty.manualTitle = undefined
  pty.manualTitleBaseline = undefined
}

/**
 * Drop a pending rename once the snapshot echoes it, or once a later desktop
 * custom title differs from the one recorded when the rename was armed.
 * Split leaves never publish `customTitle`, so a missing title must not look
 * like that later desktop edit. The first frame after a rename that had no
 * snapshot yet only arms the baseline.
 */
export function releaseEchoedManualTerminalTitles(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  ptysById: ReadonlyMap<string, ManualTitlePty>,
  leaves: Iterable<ManualTitleLeaf>
): void {
  const leafList = [...leaves]
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const pty = ptyForTerminalTab(tab, ptysById, leafList)
    if (!pty || pty.manualTitle === undefined) {
      continue
    }
    const custom = trimmedCustomTitle(tab.customTitle)
    if (pty.manualTitleBaseline === undefined) {
      if (typeof pty.manualTitle === 'string') {
        if (custom && custom === pty.manualTitle.trim()) {
          releasePendingManualTitle(pty)
        } else {
          pty.manualTitleBaseline = custom
        }
      } else if (!custom) {
        releasePendingManualTitle(pty)
      } else {
        pty.manualTitleBaseline = custom
      }
      continue
    }
    const baseline = pty.manualTitleBaseline
    if (typeof pty.manualTitle === 'string') {
      if (custom === pty.manualTitle.trim() || custom !== baseline) {
        releasePendingManualTitle(pty)
      }
      continue
    }
    if (!custom || custom !== baseline) {
      releasePendingManualTitle(pty)
    }
  }
}

type TerminalRenameLeaf = {
  tabId: string
  leafId: string
  ptyId: string | null
  worktreeId: string | null
}

type TerminalRenameHost = {
  getLivePtyForHandle(handle: string): {
    record: { tabId: string }
    pty: {
      ptyId: string
      worktreeId: string
      tabId: string | null
      title: string | null
      titleUpdatedAt: number | null
    }
  } | null
  notifier: {
    renameTerminal?: (tabId: string, title: string | null) => void
  } | null
  leaves: { values(): Iterable<TerminalRenameLeaf> }
  assertGraphReady(): void
  getLiveLeafForHandle(handle: string): { leaf: TerminalRenameLeaf }
  persistHeadlessTerminalTitle(worktreeId: string, tabId: string, title: string | null): void
  ptysById: Map<string, ManualTitlePty>
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  touchMobileSessionTabsForWorktree(worktreeId: string, options: { immediate: boolean }): void
  touchMobileSessionSnapshotsForPty(ptyId: string, options: { immediate: boolean }): void
}

function rememberManualTerminalTitle(
  host: TerminalRenameHost,
  ptyId: string | null,
  worktreeId: string | null,
  title: string | null
): void {
  const normalized = title?.trim() ? title.trim() : null
  const pty = ptyId ? host.ptysById.get(ptyId) : null
  if (pty) {
    pty.manualTitle = normalized
    pty.manualTitleBaseline = observedManualTitleBaseline(
      worktreeId ? host.mobileSessionTabsByWorktree.get(worktreeId) : undefined,
      ptyId,
      host.leaves.values()
    )
  }
  if (worktreeId) {
    host.touchMobileSessionTabsForWorktree(worktreeId, { immediate: true })
  } else if (ptyId) {
    host.touchMobileSessionSnapshotsForPty(ptyId, { immediate: true })
  }
}

/** Apply a user rename on the live PTY or the leaf, and hold it above OSC. */
export function renameRuntimeTerminal(
  host: TerminalRenameHost,
  handle: string,
  title: string | null
): RuntimeTerminalRename {
  const pty = host.getLivePtyForHandle(handle)
  if (pty) {
    pty.pty.title = title
    // Why: a manual rename must outrank later agent OSC title updates (which
    // win by timestamp), so stamp it as the freshest title.
    pty.pty.titleUpdatedAt = Date.now()
    rememberManualTerminalTitle(host, pty.pty.ptyId, pty.pty.worktreeId, title)
    // Why: without a renderer the rename only lived on the live pty and was
    // lost on restart. Persist customTitle so a headless rebuild keeps it.
    if (!host.notifier?.renameTerminal && pty.pty.tabId) {
      host.persistHeadlessTerminalTitle(pty.pty.worktreeId, pty.pty.tabId, title)
    }
    for (const leaf of host.leaves.values()) {
      if (leaf.ptyId === pty.pty.ptyId) {
        host.notifier?.renameTerminal?.(leaf.tabId, title)
        return { handle, tabId: leaf.tabId, title }
      }
    }
    const tabId = pty.pty.tabId ?? pty.record.tabId
    // A notifier can exist before its pane graph; retain the rename on the known tab.
    if (host.notifier?.renameTerminal && tabId) {
      host.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, title)
      host.notifier.renameTerminal(tabId, title)
    }
    return { handle, tabId, title }
  }
  host.assertGraphReady()
  const { leaf } = host.getLiveLeafForHandle(handle)
  rememberManualTerminalTitle(host, leaf.ptyId, leaf.worktreeId, title)
  host.notifier?.renameTerminal?.(leaf.tabId, title)
  return { handle, tabId: leaf.tabId, title }
}
