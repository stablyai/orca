// Use main's rows/order/groups, augmented by window-only rows and live view facts (selection, dirty state, titles, theme/status and editor drafts).

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import { orderIdOf, placeInMainGroups, withStrayIn } from './main-session-tab-group-placement'
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

/** Merge window facts into terminal/edit rows; keep window browser/chat/diff/preview rows whole while listed, including diff-draft dirty state. */
function isMainRow(row: Row, surfaceOnly = false): boolean {
  return (
    row.type === 'terminal' ||
    (surfaceOnly
      ? row.type === 'agent-session'
      : (row.type === 'file' && row.mode !== 'diff') ||
        (row.type === 'markdown' && row.mode === 'edit'))
  )
}

/** A terminal row with a manual name: its tab's custom title or its pane's own title. */
function isNamed(row: Extract<Row, { type: 'terminal' }>): boolean {
  return !!row.customTitle || !!row.parentLayout?.titlesByLeafId?.[row.leafId]?.trim()
}

type MergeRules = {
  exited: (ptyId: string) => boolean
  surfaceOnly?: boolean
  /** Whether a terminal runs now; given, a running window terminal outranks a binding that runs nowhere. */
  live?: (ptyId: string) => boolean
  /** Keeps every window row main does not list, terminals too, where they stood in the window. */
  keepUnlisted?: boolean
}

/** Whether the window's terminal id stands over main's binding (see withWindowFacts). */
function keepsWindowPtyId(
  main: string | null | undefined,
  window: string | null | undefined,
  { exited, live }: MergeRules
): boolean {
  if (!window || window === main) {
    return false
  }
  if (!main) {
    return !exited(window)
  }
  // Main's binding names a terminal the host saw exit; the window's has not.
  if (exited(main)) {
    return !exited(window)
  }
  // A start whose bind write is still in flight: main's binding is the terminal it replaced.
  return !!live && live(window) && !live(main)
}

/** Use window-only fields and pending terminal bindings until main catches up; main's certified exit overrides the window's old terminal id. */
function withWindowFacts(row: Row, windowRow: Row | undefined, rules: MergeRules): Row {
  if (row.type === 'terminal' && windowRow?.type === 'terminal') {
    return {
      ...row,
      // The live title (shell or agent) unless either side has a manual name.
      ...(!isNamed(row) && !isNamed(windowRow) ? { title: windowRow.title } : {}),
      ...(windowRow.terminalTheme ? { terminalTheme: windowRow.terminalTheme } : {}),
      ...(windowRow.agentStatus !== undefined ? { agentStatus: windowRow.agentStatus } : {}),
      ...(!rules.surfaceOnly && keepsWindowPtyId(row.ptyId, windowRow.ptyId, rules)
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
      documentVersion: windowRow.documentVersion,
      // The saved session never records untitled; a phone save must not make its file.
      ...(windowRow.isUntitled ? { isUntitled: true as const } : {})
    }
  }
  if (row.type === 'file' && windowRow?.type === 'file') {
    return { ...row, isDirty: windowRow.isDirty }
  }
  return row
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

/** Project main layout into window snapshots while retaining window publication stamps and any selection main still lists. */
export function withMainSessionTabRows(
  published: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows,
  exited: (ptyId: string) => boolean,
  opts: Omit<MergeRules, 'exited'> = {}
): RuntimeMobileSessionTabsSnapshot {
  const rules = { ...opts, exited }
  const windowRows = new Map(published.tabs.map((row) => [row.id, row]))
  const projectedIds = new Set(projected.tabs.map((row) => row.id))
  const windowOnly = published.tabs.filter(
    (row) => !projectedIds.has(row.id) && (rules.keepUnlisted || !isMainRow(row, rules.surfaceOnly))
  )
  // A main-held row is main's; a browser or chat row stays the window's while both list it.
  const rows = projected.tabs.map((row) =>
    isMainRow(row, rules.surfaceOnly)
      ? withWindowFacts(row, windowRows.get(row.id), rules)
      : (windowRows.get(row.id) ?? row)
  )
  const windowOnlyIds = new Set(windowOnly.map((row) => row.id))
  const merged = withWindowOnlyRows(rows, published.tabs, windowOnlyIds)
  const listed = new Map(merged.map((row) => [row.id, row]))
  const windowActive = published.activeTabId ? listed.get(published.activeTabId) : undefined
  const windowGroups = new Map((published.tabGroups ?? []).map((group) => [group.id, group]))
  // Groups list a terminal under its tab (orderIdOf), so a kept pane keeps its tab's place.
  const windowOnlyOrder = new Set(windowOnly.map(orderIdOf))
  const placement = placeInMainGroups(
    projected.tabGroups ?? [],
    published.tabGroups ?? [],
    windowOnlyOrder
  )
  // Keep each window selection if main still lists it in that group; otherwise retain main's groups/selection.
  let tabGroups: RuntimeMobileSessionTabGroup[] = placement.groups.map((group) => {
    const shown = windowActive ? windowGroups.get(group.id)?.activeTabId : undefined
    return shown && group.tabOrder.includes(shown) ? { ...group, activeTabId: shown } : group
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
  // Window-only rows from unknown groups join main's active group; never expose groups the layout lacks.
  const { stray } = placement
  if (tabGroups.length > 0) {
    tabGroups = withStrayIn(tabGroups, stray, Math.max(activeGroupIndex(windowActive), 0))
  } else if (stray.length > 0) {
    // Main lists no group: the window's groups hold the rows only it knows.
    for (const group of published.tabGroups ?? []) {
      const own = group.tabOrder.filter((id) => windowOnlyOrder.has(id))
      if (own.length > 0) {
        tabGroups.push({ ...group, tabOrder: own })
      }
    }
  }
  // Preserve user selection unless main lacks its row (not yet drawn or already closed).
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

/** Canonical content membership; the publishing device retains other kinds, placement and selection. */
export function withCanonicalSessionSurfaces(
  published: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows,
  exited: (ptyId: string) => boolean,
  nativeMembers: ReadonlySet<string> = new Set()
): RuntimeMobileSessionTabsSnapshot {
  const listed = new Set(projected.tabs.map((row) => row.id))
  projected = {
    ...projected,
    tabs: [
      ...projected.tabs,
      ...published.tabs.filter(
        (row) =>
          row.type === 'agent-session' &&
          !listed.has(row.id) &&
          nativeMembers.has(JSON.stringify([published.worktree, row.id, row.sessionId]))
      )
    ]
  }
  const surface = (row: Row): boolean => row.type === 'terminal' || row.type === 'agent-session'
  const canonical = new Map(projected.tabs.filter(surface).map((row) => [row.id, row]))
  const publishedIds = new Set(published.tabs.map((row) => row.id))
  const tabs = [
    ...published.tabs.flatMap((row) => {
      if (!surface(row)) {
        return [row]
      }
      const current = canonical.get(row.id)
      return current ? [current] : []
    }),
    ...projected.tabs.filter((row) => row.type === 'terminal' && !publishedIds.has(row.id))
  ]
  const valid = new Set(tabs.map(orderIdOf))
  const groups = (published.tabGroups ?? []).map((group) => ({
    ...group,
    tabOrder: group.tabOrder.filter((id) => valid.has(id))
  }))
  const placed = new Set(groups.flatMap((group) => group.tabOrder))
  for (const source of projected.tabGroups ?? []) {
    const added = source.tabOrder.filter((id) => valid.has(id) && !placed.has(id))
    if (!added.length) {
      continue
    }
    const group = groups.find((entry) => entry.id === source.id)
    if (group) {
      group.tabOrder.push(...added)
    } else {
      groups.push({ ...source, tabOrder: added })
    }
    for (const id of added) {
      placed.add(id)
    }
  }
  return withMainSessionTabRows(
    published,
    {
      ...projected,
      tabs,
      tabGroups: groups,
      tabGroupLayout: published.tabGroupLayout
    },
    exited,
    { surfaceOnly: true }
  )
}
