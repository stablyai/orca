// The runtime's terminal tab and leaf records, projected from the layout holder's model joined
// with the PTY registry, in the shape today's graph mirror (`tabs`, `leaves`, `leavesByPtyId`)
// gives its readers (census U15). Read-only: a fact a reader changes is written to its owner —
// connection, output and tail state to the PTY record, titles and agent status to the title
// tracker's PTY fact — and the next projection carries it.

import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeSyncedTab } from '../../shared/runtime-types'
import { resolveTerminalTabTitle } from '../../shared/tab-title-resolution'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import {
  paneKeyOf,
  tabsInOrder,
  type LayoutTerminalTab
} from '../../shared/workspace-layout/workspace-layout-model'
import type { PaneTerminalFact } from '../../shared/workspace-layout/workspace-layout-pane-status'
import { resolveWorkspaceSelection } from '../../shared/workspace-layout/workspace-layout-views'
import { pickStoredFields } from '../../shared/workspace-layout/stored-record-fields'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { getPtyTerminalState } from './terminal-wait-results'

export type RuntimeLeafProjection = {
  tabs: ReadonlyMap<string, Readonly<RuntimeSyncedTab>>
  leaves: ReadonlyMap<string, Readonly<RuntimeLeafRecord>>
  leavesByPtyId: ReadonlyMap<string, readonly Readonly<RuntimeLeafRecord>[]>
}

/** The facts a leaf record shows of its terminal; the PTY record owns every one of them. */
export const RUNTIME_LEAF_PTY_FACT_FIELDS = [
  'lastOutputAt',
  'lastExitCode',
  'lastExitCause',
  'tailBuffer',
  'tailTranscriptBuffer',
  'tailTranscriptChars',
  'tailPartialLine',
  'tailPendingAnsi',
  'tailRedrawCursor',
  'tailTruncated',
  'tailLinesTotal',
  'preview',
  'waitBlockedAt',
  'lastAgentStatus',
  'lastAgentStatusObservedLive',
  'lastOscTitle',
  'lastOscTitleAt'
] as const satisfies readonly (keyof RuntimePtyWorktreeRecord & keyof RuntimeLeafRecord)[]

export type RuntimeLeafPtyFacts = Pick<
  RuntimePtyWorktreeRecord,
  'connected' | (typeof RUNTIME_LEAF_PTY_FACT_FIELDS)[number]
>

/** A leaf with no registered terminal. */
const NO_PTY_FACTS: Omit<RuntimeLeafPtyFacts, 'connected'> = {
  lastOutputAt: null,
  lastExitCode: null,
  lastExitCause: null,
  tailBuffer: [],
  tailTranscriptBuffer: [],
  tailTranscriptChars: 0,
  tailPartialLine: '',
  tailPendingAnsi: '',
  tailRedrawCursor: null,
  tailTruncated: false,
  tailLinesTotal: 0,
  preview: '',
  waitBlockedAt: null,
  lastAgentStatus: null,
  lastAgentStatusObservedLive: false,
  lastOscTitle: null,
  lastOscTitleAt: null
}

/** The PTY registry: records by PTY id and the host's liveness verdicts. */
export type RuntimePtyRegistryView = {
  ptysById: ReadonlyMap<string, RuntimeLeafPtyFacts>
  livenessOf: (ptyId: string) => PtyLivenessVerdict | null
}

/**
 * A neutral title that replaced the pane's stuck agent title (terminal-pane-title-reset.ts), dated
 * on the PTY title observation sequence so it compares with `lastOscTitleAt`. Today the renderer
 * decides these: a confirmed return to a shell (pane-agent-identity.ts) and an inferred interrupt
 * (shell-command-inference.ts). Main sees two of the triggers (`agentStatus:inferInterrupt`,
 * `agentStatus:reconcileEndedProcess`); the title-only interrupt has none yet.
 */
export type PaneTitleReset = { title: string; at: number }

export type RuntimeLeafProjectionInput = RuntimePtyRegistryView & {
  /** Pane key → the pane's latest neutral title reset. */
  paneTitleResets: (paneKey: string) => PaneTitleReset | null
  /** Each partition the holder loaded, with the desktop's focused panes and the live tab titles. */
  partitions: readonly Pick<LoadedWorkspaceLayout, 'layout' | 'desktopView' | 'facts'>[]
  generatedTitlesEnabled: boolean
  /** The last projection: `ptyGeneration` counts a leaf's terminal changes across projections. */
  previous: RuntimeLeafProjection | null
}

/** The mirror's leaf key. */
export function runtimeLeafKey(tabId: string, leafId: string): string {
  return `${tabId}::${leafId}`
}

/** The registry's word on a bound terminal, for pane status; disconnect without exit is unverifiable. */
export function paneTerminalFact(
  ptyId: string | null,
  registry: RuntimePtyRegistryView
): PaneTerminalFact {
  if (ptyId === null) {
    return null
  }
  const verdict = registry.livenessOf(ptyId)
  if (verdict) {
    return verdict.status
  }
  const pty = registry.ptysById.get(ptyId)
  if (!pty) {
    return null
  }
  const state = getPtyTerminalState(pty)
  return state === 'running' ? 'live' : state === 'exited' ? 'exited' : 'unverifiable'
}

/** The newer of the PTY's OSC title and a neutral reset, as the window's pane title is today. */
function latestPaneTitle(
  pty: RuntimeLeafPtyFacts | undefined,
  reset: PaneTitleReset | null
): { title: string | null; at: number | null } {
  const osc = { title: pty?.lastOscTitle ?? null, at: pty?.lastOscTitleAt ?? null }
  return reset && (osc.at === null || reset.at > osc.at) ? reset : osc
}

function projectLeaf(
  tab: LayoutTerminalTab,
  base: { worktreeId: string; leafId: string; ptyId: string | null; liveTitle: string },
  input: RuntimeLeafProjectionInput
): RuntimeLeafRecord {
  const { ptyId, leafId } = base
  const pty = ptyId === null ? undefined : input.ptysById.get(ptyId)
  // As the mirror: connected unless the host proved an exit. A binding with no PTY record is not:
  // the mirror would have created one from the window's live transport, the holder has none.
  const connected =
    ptyId !== null && pty !== undefined && input.livenessOf(ptyId)?.status !== 'exited'
  const previous = input.previous?.leaves.get(runtimeLeafKey(tab.entityId, leafId))
  const paneTitle = latestPaneTitle(pty, input.paneTitleResets(paneKeyOf(tab.entityId, leafId)))
  const paneLiveTitle = paneTitle.title ?? base.liveTitle
  return {
    tabId: tab.entityId,
    worktreeId: base.worktreeId,
    leafId,
    // No renderer pane backs a holder leaf; -1 as other runtime-made leaves use.
    paneRuntimeId: -1,
    ptyId,
    // Dated by the title itself, not by a graph sync that relayed it.
    paneTitle: paneTitle.title,
    paneTitleUpdatedAt: paneTitle.at,
    title: resolveTerminalTabTitle(
      { ...tab, title: paneLiveTitle },
      input.generatedTitlesEnabled,
      paneLiveTitle
    ),
    ptyGeneration:
      previous && previous.ptyId !== ptyId
        ? previous.ptyGeneration + 1
        : (previous?.ptyGeneration ?? 0),
    ...NO_PTY_FACTS,
    ...(pty ? pickStoredFields(pty, RUNTIME_LEAF_PTY_FACT_FIELDS) : {}),
    connected,
    // The holder's graph is always ready, so a connected leaf is writable.
    writable: connected
  }
}

/** A pane of a terminal tab in the holder's model, before any PTY fact is joined. */
export type RuntimeSurfacePane = {
  tab: LayoutTerminalTab
  worktreeId: string
  leafId: string
  ptyId: string | null
  liveTitle: string
}

/** The holder's terminal tabs and panes in tab and pane order; the layout half of the projection. */
export function projectRuntimeSurfaces(
  partitions: RuntimeLeafProjectionInput['partitions'],
  generatedTitlesEnabled: boolean
): { tabs: Map<string, Readonly<RuntimeSyncedTab>>; panes: RuntimeSurfacePane[] } {
  const tabs = new Map<string, Readonly<RuntimeSyncedTab>>()
  const panes: RuntimeSurfacePane[] = []
  for (const { layout, desktopView, facts } of partitions) {
    for (const [key, workspace] of Object.entries(layout.workspaces)) {
      const selection = resolveWorkspaceSelection(desktopView, key, workspace)
      for (const tab of tabsInOrder(workspace)) {
        if (tab.kind !== 'terminal') {
          continue
        }
        const liveTitle = facts.terminalRows[tab.entityId]?.title ?? tab.terminal.defaultTitle ?? ''
        tabs.set(tab.entityId, {
          tabId: tab.entityId,
          worktreeId: workspace.worktreeId,
          title: resolveTerminalTabTitle(
            { ...tab, title: liveTitle },
            generatedTitlesEnabled,
            liveTitle
          ),
          activeLeafId: selection.panes[tab.entityId]?.activeLeafId ?? null,
          layout: tab.panes.root
        })
        for (const leafId of collectLayoutLeafIdsInOrder(tab.panes.root)) {
          const ptyId = workspace.leaves?.[leafId]?.ptyId ?? null
          panes.push({ tab, worktreeId: workspace.worktreeId, leafId, ptyId, liveTitle })
        }
      }
    }
  }
  return { tabs, panes }
}

export function projectRuntimeLeafRecords(
  input: RuntimeLeafProjectionInput
): RuntimeLeafProjection {
  const { tabs, panes } = projectRuntimeSurfaces(input.partitions, input.generatedTitlesEnabled)
  const leaves = new Map<string, Readonly<RuntimeLeafRecord>>()
  const leavesByPtyId = new Map<string, Readonly<RuntimeLeafRecord>[]>()
  for (const { tab, ...base } of panes) {
    const leaf = projectLeaf(tab, base, input)
    leaves.set(runtimeLeafKey(tab.entityId, base.leafId), leaf)
    if (base.ptyId !== null) {
      leavesByPtyId.set(base.ptyId, [...(leavesByPtyId.get(base.ptyId) ?? []), leaf])
    }
  }
  return { tabs, leaves, leavesByPtyId }
}
