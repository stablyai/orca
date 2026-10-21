// Layout-owner builds, before main holds browser and chat records (D3b): a workspace main owns
// publishes its terminal and editor rows, tab order and groups from main's layout
// (projectSessionTabs). The window's live publication supplies what the user sees: selection, the
// focused pane, dirty state and live terminal titles (main's copy of the view lags a debounced
// save), the rows main's model does not hold (browser, chat, diff and other view-only editor rows)
// and the facts only the window has (terminal theme, agent status, launch drafts, a markdown
// view's mode, file id and draft version).

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'

type Row = RuntimeMobileSessionSnapshotTab

/** Main's projection of the rows (projectSessionTabs): the snapshot minus the runtime's stamps. */
export type MainSessionTabRows = Omit<
  RuntimeMobileSessionTabsSnapshot,
  'publicationEpoch' | 'snapshotVersion' | 'worktreeInstanceId' | 'retiredTerminalSurfaces'
>

/**
 * Rows main's layout answers for: terminals and edit-mode files (the model holds no diff or
 * preview-only tab). Any other row is the window's until D3b.
 */
function isMainRow(row: Row): boolean {
  return (
    row.type === 'terminal' ||
    (row.type === 'file' && row.mode !== 'diff') ||
    (row.type === 'markdown' && row.mode === 'edit')
  )
}

/**
 * Main's row with the fields only the window knows, from the window's row of the same id. A
 * window terminal id names a pane main has not bound yet (an SSH restore before its terminal
 * registers), unless main has seen that terminal exit: then main's cleared binding wins.
 */
function withWindowFacts(
  row: Row,
  windowRow: Row | undefined,
  exited: (ptyId: string) => boolean
): Row {
  if (row.type === 'terminal' && windowRow?.type === 'terminal') {
    return {
      ...row,
      // The live title (shell or agent) unless either side has a manual name.
      ...(!row.customTitle && !windowRow.customTitle ? { title: windowRow.title } : {}),
      ...(windowRow.terminalTheme ? { terminalTheme: windowRow.terminalTheme } : {}),
      ...(windowRow.agentStatus !== undefined ? { agentStatus: windowRow.agentStatus } : {}),
      ...(!row.ptyId && windowRow.ptyId && !exited(windowRow.ptyId)
        ? { ptyId: windowRow.ptyId }
        : {}),
      ...(windowRow.launchDraft !== undefined ? { launchDraft: windowRow.launchDraft } : {}),
      ...(windowRow.launchDraftCreatedAt !== undefined
        ? { launchDraftCreatedAt: windowRow.launchDraftCreatedAt }
        : {})
    }
  }
  if (row.type === 'markdown' && windowRow?.type === 'markdown') {
    return {
      ...row,
      isDirty: windowRow.isDirty,
      mode: windowRow.mode,
      sourceFileId: windowRow.sourceFileId,
      documentVersion: windowRow.documentVersion
    }
  }
  if (row.type === 'file' && windowRow?.type === 'file') {
    return { ...row, isDirty: windowRow.isDirty }
  }
  return row
}

/** The id a group's tab order lists a row under: a terminal pane's tab, else the row itself. */
function orderIdOf(row: Row): string {
  return row.type === 'terminal' ? row.parentTabId : row.id
}

/** Each window-only id placed after the id it follows in the window's group, else at the end. */
function withWindowOnlyIds(
  tabOrder: readonly string[],
  windowOrder: readonly string[],
  windowOnly: ReadonlySet<string>
): string[] {
  const order = [...tabOrder]
  windowOrder.forEach((id, index) => {
    if (!windowOnly.has(id) || order.includes(id)) {
      return
    }
    const after = windowOrder
      .slice(0, index)
      .toReversed()
      .find((previous) => order.includes(previous))
    order.splice(after === undefined ? 0 : order.indexOf(after) + 1, 0, id)
  })
  return order
}

/** Main's rows in main's order, each window-only row after the row it follows in the window's. */
function withWindowOnlyRows(
  rows: Row[],
  windowRows: readonly Row[],
  windowOnly: ReadonlySet<string>
): Row[] {
  const merged = [...rows]
  windowRows.forEach((row, index) => {
    if (!windowOnly.has(row.id)) {
      return
    }
    const after = windowRows
      .slice(0, index)
      .toReversed()
      .find((previous) => merged.some((entry) => entry.id === previous.id))
    const at = after ? merged.findIndex((entry) => entry.id === after.id) + 1 : 0
    merged.splice(at, 0, row)
  })
  return merged
}

/**
 * The window's live snapshot of a workspace main owns, with main's terminal and editor rows, tab
 * order and groups. The window keeps its publication stamps (so the snapshot fences hold as today)
 * and its view: what it selects stands whenever main lists that row.
 */
export function withMainSessionTabRows(
  published: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows,
  exited: (ptyId: string) => boolean
): RuntimeMobileSessionTabsSnapshot {
  const windowRows = new Map(published.tabs.map((row) => [row.id, row]))
  const projectedIds = new Set(projected.tabs.map((row) => row.id))
  const windowOnly = published.tabs.filter((row) => !projectedIds.has(row.id) && !isMainRow(row))
  // A main-held row is main's; a browser or chat row stays the window's while both list it.
  const rows = projected.tabs.map((row) =>
    isMainRow(row)
      ? withWindowFacts(row, windowRows.get(row.id), exited)
      : (windowRows.get(row.id) ?? row)
  )
  const windowOnlyIds = new Set(windowOnly.map((row) => row.id))
  const merged = withWindowOnlyRows(rows, published.tabs, windowOnlyIds)
  const listed = new Map(merged.map((row) => [row.id, row]))
  const windowActive = published.activeTabId ? listed.get(published.activeTabId) : undefined
  const windowGroups = new Map((published.tabGroups ?? []).map((group) => [group.id, group]))
  const tabGroups: RuntimeMobileSessionTabGroup[] = (projected.tabGroups ?? []).map((group) => {
    const tabOrder = withWindowOnlyIds(
      group.tabOrder,
      windowGroups.get(group.id)?.tabOrder ?? [],
      windowOnlyIds
    )
    // The tab the window shows in this group, when main's group still holds it; while main's
    // selection stands (the window selects a row main lacks), main's groups stay as main has them.
    const shown = windowActive ? windowGroups.get(group.id)?.activeTabId : undefined
    return {
      ...group,
      tabOrder,
      ...(shown && tabOrder.includes(shown) ? { activeTabId: shown } : {})
    }
  })
  const activeGroupIndex = (activeRow: Row | undefined): number => {
    const byRow = activeRow
      ? tabGroups.findIndex((group) => group.tabOrder.includes(orderIdOf(activeRow)))
      : -1
    if (byRow !== -1) {
      return byRow
    }
    const byWindow = windowActive
      ? tabGroups.findIndex((group) => group.id === published.activeGroupId)
      : -1
    return byWindow !== -1
      ? byWindow
      : tabGroups.findIndex((group) => group.id === projected.activeGroupId)
  }
  const placed = new Set(tabGroups.flatMap((group) => group.tabOrder))
  // A window-only row in a group main does not hold joins the active group: groups and their
  // layout are main's, so the phone gets no group the layout lacks.
  const stray = (published.tabGroups ?? []).flatMap((group) =>
    group.tabOrder.filter((id) => windowOnlyIds.has(id) && !placed.has(id))
  )
  const strayInto = Math.max(activeGroupIndex(windowActive), 0)
  const strayGroup = tabGroups[strayInto]
  if (stray.length > 0 && strayGroup) {
    tabGroups[strayInto] = { ...strayGroup, tabOrder: [...strayGroup.tabOrder, ...stray] }
  } else if (stray.length > 0) {
    // Main lists no group: the window's groups hold the rows only it knows.
    for (const group of published.tabGroups ?? []) {
      const own = group.tabOrder.filter((id) => windowOnlyIds.has(id))
      if (own.length > 0) {
        tabGroups.push({ ...group, tabOrder: own })
      }
    }
  }
  // The window's selection is the user's view; main's stands only while the window selects a row
  // main does not list (a pane drawn before main's frame, or one main closed).
  const index = activeGroupIndex(windowActive)
  const activeGroup = index === -1 ? undefined : tabGroups[index]
  if (windowActive && activeGroup) {
    tabGroups[index] = { ...activeGroup, activeTabId: orderIdOf(windowActive) }
  }
  const selection = windowActive
    ? {
        activeGroupId: activeGroup?.id ?? projected.activeGroupId,
        activeTabId: windowActive.id,
        activeTabType: windowActive.type
      }
    : {
        activeGroupId: projected.activeGroupId,
        activeTabId: projected.activeTabId,
        activeTabType: projected.activeTabType
      }
  const activeId = selection.activeTabId
  const { tabGroups: _windowGroups, tabGroupLayout: _windowLayout, ...stamps } = published
  return {
    ...stamps,
    ...selection,
    ...(tabGroups.length > 0 ? { tabGroups } : {}),
    ...(projected.tabGroupLayout
      ? { tabGroupLayout: projected.tabGroupLayout }
      : tabGroups.length > 0 && published.tabGroupLayout
        ? { tabGroupLayout: published.tabGroupLayout }
        : {}),
    tabs: merged.map((row) =>
      row.isActive === (row.id === activeId) ? row : { ...row, isActive: row.id === activeId }
    )
  }
}
