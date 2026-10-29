import {
  sessionPaneAliasRecipes,
  type SessionPaneAliasRecipe
} from '../restoring-sessions/session-pane-alias-recipes'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  deleteTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'

import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import type { SessionRefSnapshot, Partition, PublicationState } from './session-publication'
export type SessionAliasSink = (owner: string, recipes: readonly SessionPaneAliasRecipe[]) => void

export class SessionPublicationResources {
  private readonly durableRefs = new Map<ExecutionHostId, Readonly<Record<string, number>>>()
  private readonly inFlightRefs = new Set<SessionRefSnapshot>()
  private readonly removedRefs = new Set<string>()
  constructor(
    private readonly epoch: string,
    private readonly partitions: Map<ExecutionHostId, Partition>,
    private readonly publishAliases?: SessionAliasSink
  ) {}
  initialize(state: PublicationState, durableState: PublicationState): void {
    for (const recipe of state.legacyPaneKeyAliasEntries ?? []) {
      const pane = parsePaneKey(recipe.stablePaneKey)
      if (!pane) {
        continue
      }
      for (const [hostId, partition] of this.partitions) {
        if (!partition.index.ids('terminalLayoutsByTabId', pane.tabId, 'leaf').has(pane.leafId)) {
          continue
        }
        if (
          !partition.index
            .references('pty', recipe.ptyId)
            .some((unit) => unit.field === 'terminalLayoutsByTabId' && unit.key === pane.tabId)
        ) {
          continue
        }
        partition.aliases.set(pane.tabId, [...(partition.aliases.get(pane.tabId) ?? []), recipe])
        this.updateAliasRecipes(hostId, pane.tabId, partition.root)
      }
    }
    for (const key of [
      LOCAL_EXECUTION_HOST_ID,
      ...Object.keys(durableState.workspaceSessionsByHostId ?? {})
    ]) {
      const hostId = normalizeExecutionHostId(key)
      if (!hostId) {
        continue
      }
      const root =
        hostId === LOCAL_EXECUTION_HOST_ID
          ? durableState.workspaceSession
          : durableState.workspaceSessionsByHostId?.[hostId]
      const index = root ? new SessionUnitIndex(root) : undefined
      const refs = Object.fromEntries(
        [...(index?.scrollbackRefs() ?? [])].map((ref) => [ref, index?.scrollbackCount(ref) ?? 0])
      )
      this.durableRefs.set(hostId, refs)
      for (const ref of Object.keys(refs)) {
        if (![...this.partitions.values()].some((partition) => (partition.refs[ref] ?? 0) > 0)) {
          this.removedRefs.add(ref)
        }
      }
    }
  }
  updateAliasRecipes(hostId: ExecutionHostId, tabId: string, root: WorkspaceSessionState): void {
    const partition = this.partitions.get(hostId)
    if (!partition || !this.publishAliases) {
      return
    }
    const reader = new SessionUnitReader(root, partition.index)
    const layout = root.terminalLayoutsByTabId?.[tabId]
    const previous = partition.aliases.get(tabId) ?? []
    const entries = new Map<string, SessionPaneAliasRecipe>()
    if (layout) {
      for (const recipe of [...previous, ...sessionPaneAliasRecipes(layout)]) {
        const pane = parsePaneKey(recipe.stablePaneKey)
        if (
          !pane ||
          !partition.index.ids('terminalLayoutsByTabId', tabId, 'leaf').has(pane.leafId)
        ) {
          continue
        }
        const owner = reader.terminalOwner(tabId, 'last')
        const tab = owner && partition.index.terminalRow(owner, tabId)
        const ptyId = layout.ptyIdsByLeafId?.[pane.leafId] ?? (tab && tab.ptyId) ?? undefined
        entries.set(recipe.legacyPaneKey, { ...recipe, ptyId })
      }
    }
    const recipes = [...entries.values()]
    if (recipes.length) {
      partition.aliases.set(tabId, recipes)
    } else {
      partition.aliases.delete(tabId)
    }
    this.publishAliases?.(JSON.stringify([this.epoch, hostId, tabId]), recipes)
  }
  captureRefs(dirtyDomains: ReadonlySet<string> | null): SessionRefSnapshot {
    const snapshot: SessionRefSnapshot = new Map()
    for (const [hostId, partition] of this.partitions) {
      const domain =
        hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
      if (dirtyDomains === null || dirtyDomains.has(domain)) {
        snapshot.set(hostId, partition.refs)
      }
    }
    this.inFlightRefs.add(snapshot)
    return snapshot
  }
  finishRefs(
    snapshot: SessionRefSnapshot,
    outcome: 'committed' | 'failed' | 'indeterminate',
    storage?: TerminalScrollbackSnapshotStorage,
    migrationHolds: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  ): void {
    if (outcome === 'indeterminate') {
      return
    }
    this.inFlightRefs.delete(snapshot)
    if (outcome !== 'committed') {
      return
    }
    for (const [hostId, refs] of snapshot) {
      this.durableRefs.set(hostId, refs)
    }
    // Successful admitted recovery supersedes earlier uncertain snapshots of these domains.
    for (const pending of this.inFlightRefs) {
      for (const hostId of snapshot.keys()) {
        pending.delete(hostId)
      }
      if (!pending.size) {
        this.inFlightRefs.delete(pending)
      }
    }
    for (const ref of this.removedRefs) {
      const kept =
        [...this.partitions.values()].some((partition) => (partition.refs[ref] ?? 0) > 0) ||
        [...this.durableRefs.values()].some((refs) => (refs[ref] ?? 0) > 0) ||
        [...this.inFlightRefs].some((pending) =>
          [...pending.values()].some((refs) => (refs[ref] ?? 0) > 0)
        ) ||
        [...migrationHolds.values()].some((refs) => refs.has(ref))
      if (!kept) {
        deleteTerminalScrollbackSnapshotSync(ref, storage)
        this.removedRefs.delete(ref)
      }
    }
  }
  dispose(): void {
    for (const [hostId, partition] of this.partitions) {
      for (const tabId of partition.aliases.keys()) {
        this.publishAliases?.(JSON.stringify([this.epoch, hostId, tabId]), [])
      }
    }
  }
  noteRefs(refDeltas: ReadonlyMap<string, number>): void {
    for (const [ref, delta] of refDeltas) {
      if (delta < 0) {
        this.removedRefs.add(ref)
      }
      if ([...this.partitions.values()].some((part) => (part.refs[ref] ?? 0) > 0)) {
        this.removedRefs.delete(ref)
      }
    }
  }
}
