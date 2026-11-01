import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { WorkspaceLayoutLoadContext } from '../../../../shared/workspace-layout/workspace-layout-load-types'
import { isPaneSleepRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  pairedRuntimeHostOfBinding,
  terminalHoldsPane,
  type MainTerminalSurfaces,
  type BoundTerminal
} from './terminal-surface-index'
// Read pane copies only in the window-owned branch; main-owned builds use layout alone. Delete these copies with the legacy branch (L80).

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

export type PtyPane = {
  tabId: string | null
  paneKey: string | null
  /** The graph sequence the pane is good as of; see pty-recorded-surface-topology.ts. */
  recordedAtGraphSequence: number
}

export type PtyPaneSource = Pick<
  RuntimePtyWorktreeRecord,
  'ptyId' | 'tabId' | 'paneKey' | 'surfaceRecordedAtGraphSequence'
>

/** How a helper outside the runtime asks for a terminal's pane: the runtime's `paneOfPty`. */
export type PtyPaneOf = (pty: PtyPaneSource) => PtyPane

/** The pane main's layout binds a terminal to; null when no pane main owns holds it. */
export type MainPaneOfPty = (ptyId: string) => { tabId: string; leafId: string } | null

const NO_PANE: PtyPane = Object.freeze({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 })

/** The tab and pane that hold a terminal; null fields when none does or there is no record. */
export function paneOfPty(
  pty: PtyPaneSource | null | undefined,
  mainPaneOf: MainPaneOfPty
): PtyPane {
  if (!pty) {
    return NO_PANE
  }
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const pane = mainPaneOf(pty.ptyId)
    if (!pane) {
      return NO_PANE
    }
    // Main's binding is current by definition, so no graph statement outranks it.
    return {
      tabId: pane.tabId,
      paneKey:
        isValidTerminalTabId(pane.tabId) && isTerminalLeafId(pane.leafId)
          ? makePaneKey(pane.tabId, pane.leafId)
          : null,
      recordedAtGraphSequence: Number.POSITIVE_INFINITY
    }
  }
  return {
    tabId: pty.tabId ?? null,
    paneKey: pty.paneKey ?? null,
    recordedAtGraphSequence: pty.surfaceRecordedAtGraphSequence ?? 0
  }
}

export function captureMainTerminalPaneLookup(
  surfaces: MainTerminalSurfaces,
  registered: (ptyId: string) => BoundTerminal | null
): (ptyId: string) => { worktreeId: string; tabId: string; leafId: string } | null {
  const candidates = new Map<string, typeof surfaces.leaves>()
  const terminals = new Map<string, BoundTerminal | null>()
  const facts = new Map([...surfaces.paneFacts].map(([key, value]) => [key, { ...value }]))
  for (const leaf of surfaces.leaves) {
    if (!leaf.ptyId) {
      continue
    }
    const bucket = candidates.get(leaf.ptyId) ?? []
    bucket.push({ ...leaf })
    candidates.set(leaf.ptyId, bucket)
    if (!terminals.has(leaf.ptyId)) {
      const terminal = registered(leaf.ptyId)
      terminals.set(
        leaf.ptyId,
        terminal ? { worktreeId: terminal.worktreeId, incarnationId: terminal.incarnationId } : null
      )
    }
  }
  return (ptyId) =>
    findMainTerminalPane(ptyId, candidates.get(ptyId) ?? [], facts, terminals.get(ptyId) ?? null)
}

export function findMainTerminalPane(
  ptyId: string,
  leaves: MainTerminalSurfaces['leaves'],
  facts: MainTerminalSurfaces['paneFacts'],
  terminal: BoundTerminal | null
): { worktreeId: string; tabId: string; leafId: string } | null {
  const pane = leaves.find(
    (leaf) =>
      leaf.ptyId === ptyId &&
      (pairedRuntimeHostOfBinding(ptyId) !== null ||
        terminalHoldsPane(terminal, leaf, facts.get(`${leaf.tabId}::${leaf.leafId}`)))
  )
  return pane ? { worktreeId: pane.worktreeId, tabId: pane.tabId, leafId: pane.leafId } : null
}

/** Raw invalidation inputs only; main's loader and pane qualifier still select every binding. */
export function mainTerminalSourceInputs(
  session: WorkspaceSessionState | null | undefined,
  context: WorkspaceLayoutLoadContext
) {
  if (!session) {
    return null
  }
  return structuredClone({
    tabs: Object.entries(session.tabsByWorktree ?? {}).map(([key, rows]) => [
      key,
      rows.map((row) => [row.id, row.worktreeId, row.ptyId, row.sortOrder, row.createdAt])
    ]),
    tabBar: Object.entries(session.unifiedTabs ?? {}).map(([key, rows]) => [
      key,
      rows.map((row) => [
        row.id,
        row.contentType,
        row.entityId,
        row.groupId,
        row.sortOrder,
        row.createdAt
      ])
    ]),
    groups: Object.entries(session.tabGroups ?? {}).map(([key, groups]) => [
      key,
      groups.map((group) => [group.id, group.tabOrder])
    ]),
    groupLayouts: session.tabGroupLayouts,
    layouts: Object.entries(session.terminalLayoutsByTabId ?? {}).map(([id, layout]) => [
      id,
      collectLayoutLeafIdsInOrder(layout.root),
      layout.ptyIdsByLeafId,
      collectLayoutLeafIdsInOrder(layout.root).map((leaf) => [
        leaf,
        context.ptyGenerationOf?.(leaf)
      ])
    ]),
    incarnations: session.terminalPtyIncarnationsByPaneKey,
    sleeping: Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).map(([key, record]) => [
      key,
      isPaneSleepRecord(record)
    ]),
    retired: session.terminalSurfaceTombstonesByPaneKey,
    closedTabs: session.closedTerminalTabTombstonesByTabId,
    closedPanes: session.closedTerminalPanesByPaneKey
  })
}
