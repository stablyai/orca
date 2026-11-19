import { randomUUID } from 'node:crypto'
import { OrcaRuntimeWithAdmitWindowPublisher } from './session-window-publisher'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey
} from '../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../terminal/records/runtime-terminal-state-records'

/** An Agent-slept pane keeps its handle while it has no process, so its resume answers to the same name. */
export abstract class OrcaRuntimeWithSleptLeafHandles extends OrcaRuntimeWithAdmitWindowPublisher {
  /** Per slept leaf, its handle and the process it named; kept across graph reloads so the pane keeps its name. */
  protected readonly sleptLeafHandles = new Map<string, { handle: string; ptyId: string }>()

  /** Graph sync rebinds handles; waits on a woken slept pane re-check here. */
  protected onSleptLeafGraphSynced(): void {}

  /** A slept pane moved to another tab keeps its name: same leaf id, still without a process. */
  protected carrySleptLeafHandle(
    oldLeafKey: string,
    nextLeaves: ReadonlyMap<string, RuntimeLeafRecord>
  ): boolean {
    const parked = this.sleptLeafHandles.get(oldLeafKey)
    const record = parked ? this.handles.get(parked.handle) : undefined
    if (!parked || !record || record.ptyId !== null) {
      return false
    }
    for (const [leafKey, leaf] of nextLeaves) {
      if (leaf.leafId === record.leafId && leaf.ptyId === null && leafKey !== oldLeafKey) {
        this.terminalIdentity.unbindLeaf(oldLeafKey)
        this.terminalIdentity.setHandle(parked.handle, {
          ...record,
          tabId: leaf.tabId,
          worktreeId: leaf.worktreeId
        })
        this.terminalIdentity.bindLeaf(leafKey, parked.handle)
        this.sleptLeafHandles.delete(oldLeafKey)
        this.sleptLeafHandles.set(leafKey, parked)
        return true
      }
    }
    return false
  }

  /** Closed panes take their slept names with them; a reloading graph may be partial, so it prunes nothing. */
  protected pruneSleptLeafHandles(): void {
    for (const leafKey of this.graphStatus === 'reloading' ? [] : this.sleptLeafHandles.keys()) {
      if (!this.leaves.has(leafKey)) {
        this.sleptLeafHandles.delete(leafKey)
      }
    }
    this.onSleptLeafGraphSynced()
  }

  /** Main's hook row names the exact process Agent Sleep stopped in this pane. */
  protected isAgentSleepStop(paneKey: string, ptyId: string): boolean {
    return this.agentSleepStopPtyId(paneKey) === ptyId
  }

  private agentSleepStopPtyId(paneKey: string): string | null {
    return this.agentSleepStopRow(paneKey)?.paneSleep?.ptyId ?? null
  }

  private agentSleepStopRow(paneKey: string) {
    // Only the newest row speaks for the pane: a resumed agent's own rows supersede the sleep's.
    const rows = this.getAgentStatusSnapshotForPaneFn?.(paneKey) ?? []
    const latest = rows.reduce<(typeof rows)[number] | null>(
      (newest, row) => (!newest || row.receivedAt > newest.receivedAt ? row : newest),
      null
    )
    return latest?.paneSleep ? latest : null
  }

  /** A pane's new process keeps the handle when it is the pane's first (mobile already subscribed
   *  to it), or when Agent Sleep stopped the previous one: the handle waits for, then names, the resume. */
  protected retainLeafHandle(
    leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId'>,
    previousPtyId: string | null,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    if (previousPtyId === null) {
      return this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
    }
    if (
      !isTerminalLeafId(leaf.leafId) ||
      !this.isAgentSleepStop(makePaneKey(leaf.tabId, leaf.leafId), previousPtyId)
    ) {
      return false
    }
    return ptyId === null
      ? this.parkSleptLeafHandle(leafKey, ptyGeneration)
      : this.rebindSleptLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  /** Keep a slept pane's handle on its now terminal-less leaf instead of retiring it. */
  protected parkSleptLeafHandle(leafKey: string, ptyGeneration: number): boolean {
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record?.ptyId) {
      return false
    }
    const sleptPtyId = record.ptyId
    // The stopped process keeps no alias: the name now belongs to the pane's next process.
    if (this.handleByPtyId.get(sleptPtyId) === handle) {
      this.terminalIdentity.unbindPty(sleptPtyId)
    }
    if (this.handleByPtyIncarnation.get(sleptPtyId)?.handle === handle) {
      this.terminalIdentity.removeIncarnation(sleptPtyId)
    }
    this.terminalIdentity.setHandle(handle, { ...record, ptyId: null, ptyGeneration })
    this.sleptLeafHandles.set(leafKey, { handle, ptyId: sleptPtyId })
    return true
  }

  /** A restart left the slept pane bound to its stopped process; its resume takes over the same handle. */
  protected rebindSleptLeafHandle(leafKey: string, ptyId: string, ptyGeneration: number): boolean {
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record?.ptyId || this.ptysById.get(record.ptyId)?.connected === true) {
      return false
    }
    this.parkSleptLeafHandle(leafKey, ptyGeneration)
    return this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  /** The handle a slept pane answers to: parked with no terminal, or, after a restart, still bound
   *  to the exact process Agent Sleep stopped. Null when the pane runs a process or never slept. */
  protected sleptLeafHandle(leaf: RuntimeLeafRecord): string | null {
    if (!isTerminalLeafId(leaf.leafId)) {
      return null
    }
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const paneKey = makePaneKey(leaf.tabId, leaf.leafId)
    const handle = this.handleByLeafKey.get(leafKey)
    if (handle && this.handles.get(handle)?.ptyId === leaf.ptyId) {
      const slept =
        leaf.ptyId === null
          ? this.sleptLeafHandles.get(leafKey)?.handle === handle
          : this.ptysById.get(leaf.ptyId)?.connected !== true &&
            this.isAgentSleepStop(paneKey, leaf.ptyId)
      if (slept) {
        return handle
      }
    }
    return this.restoreSleptLeafHandle(leaf, leafKey, paneKey)
  }

  /** A restart or renderer reload drops parked handles; main's kept sleep row still marks the pane.
   *  The agent's own exported handle is reused so mail and worker-list still name it. */
  private restoreSleptLeafHandle(
    leaf: RuntimeLeafRecord,
    leafKey: string,
    paneKey: string
  ): string | null {
    const current = this.handleByLeafKey.get(leafKey)
    const currentPtyId = current ? this.handles.get(current)?.ptyId : null
    // The graph can lag the pane: a woken process already named, or a parked name, is never reminted.
    if (currentPtyId && this.ptysById.get(currentPtyId)?.connected === true) {
      return null
    }
    const parked = this.sleptLeafHandles.get(leafKey)?.handle
    if (current && current === parked) {
      return current
    }
    const sleepRow = this.agentSleepStopRow(paneKey)
    const sleptPtyId = sleepRow?.paneSleep?.ptyId
    if (
      !sleptPtyId ||
      (leaf.ptyId !== null && leaf.ptyId !== sleptPtyId) ||
      this.ptysById.get(sleptPtyId)?.connected === true
    ) {
      return null
    }
    // The slept agent's own hook row carries the handle it answered to; a pane's older Dispatch may name another conversation.
    const handle =
      [parked, sleepRow?.terminalHandle].find((kept) => kept && !this.handles.has(kept)) ??
      `term_${randomUUID()}`
    this.terminalIdentity.addSynthetic(handle)
    this.terminalIdentity.setHandle(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.terminalIdentity.bindLeaf(leafKey, handle)
    this.sleptLeafHandles.set(leafKey, { handle, ptyId: sleptPtyId })
    return handle
  }

  protected isSleptAgentLeaf(leaf: RuntimeLeafRecord): boolean {
    return this.sleptLeafHandle(leaf) !== null
  }

  /** The handle a spawn into this slept pane takes, so its process exports the pane's old name. */
  sleptPaneHandleForSpawn(paneKey: string | null | undefined): string | null {
    const pane = paneKey ? parsePaneKey(paneKey) : null
    const leaf = pane ? this.leaves.get(this.getLeafKey(pane.tabId, pane.leafId)) : undefined
    return leaf ? this.sleptLeafHandle(leaf) : null
  }

  /** A slept agent's handle and its stopped process, whose kept output stands for the idle agent. */
  protected sleptAgentHandle(
    handle: string
  ): { pty: RuntimePtyWorktreeRecord | null; leaf: RuntimeLeafRecord } | null {
    const record = this.handles.get(handle)
    const leaf = record ? this.leaves.get(this.getLeafKey(record.tabId, record.leafId)) : undefined
    if (!record || !leaf || this.sleptLeafHandle(leaf) !== handle) {
      return null
    }
    const ptyId =
      record.ptyId ?? this.sleptLeafHandles.get(this.getLeafKey(record.tabId, record.leafId))?.ptyId
    return { pty: (ptyId && this.ptysById.get(ptyId)) || null, leaf }
  }
}
