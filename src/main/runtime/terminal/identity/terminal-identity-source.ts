import type { RuntimeSyncedTab } from '../../../../shared/runtime-session-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import type { TerminalHandleRecord, PtyIncarnationHandleRecord } from './terminal-handle-records'

import { OrderedTerminalCandidates } from './ordered-terminal-candidates'
import { TerminalIncarnationBindings } from './terminal-incarnation-bindings'
import { TerminalPaneCandidates } from './terminal-pane-candidates'
import { retireReplacedLaunch } from '../launch/launch-evidence'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
/** Canonical terminal facts; semantic operations retain selection, callbacks and failure policy. */
export class TerminalIdentitySource {
  private readonly ptyRecords = new Map<string, Mutable<RuntimePtyWorktreeRecord>>()
  private leafRecords = new Map<string, Mutable<RuntimeLeafRecord>>()
  private tabRecords = new Map<string, Readonly<RuntimeSyncedTab>>()
  private readonly handleRecords = new Map<string, TerminalHandleRecord>()
  private readonly ptyBindings = new Map<string, string>()
  private readonly leafBindings = new Map<string, string>()
  private readonly reverseCandidates = new OrderedTerminalCandidates()
  private readonly incarnationSource = new TerminalIncarnationBindings(() => this.changed())
  readonly paneCandidates = new TerminalPaneCandidates()
  private readonly syntheticHandles = new Set<string>()
  // Weak ownership links preserve detached canonical records without retaining their lifetime.
  private readonly ownedPtys = new WeakMap<object, Mutable<RuntimePtyWorktreeRecord>>()
  private readonly ownedLeaves = new WeakMap<RuntimeLeafRecord, Mutable<RuntimeLeafRecord>>()
  private sequence = 0
  private epoch = 0

  constructor(private readonly retire: () => void) {}

  readonly ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord> = this.ptyRecords
  get leaves(): ReadonlyMap<string, RuntimeLeafRecord> {
    return this.leafRecords
  }
  get tabs(): ReadonlyMap<string, Readonly<RuntimeSyncedTab>> {
    return this.tabRecords
  }
  readonly handles: ReadonlyMap<string, TerminalHandleRecord> = this.handleRecords
  readonly reverse: ReadonlyMap<string, string> = this.ptyBindings
  readonly leafHandles: ReadonlyMap<string, string> = this.leafBindings
  readonly incarnations: ReadonlyMap<string, PtyIncarnationHandleRecord> =
    this.incarnationSource.records
  readonly synthetic: ReadonlySet<string> = this.syntheticHandles
  get graphSequence(): number {
    return this.sequence
  }
  get rendererGraphEpoch(): number {
    return this.epoch
  }

  private changed(): void {
    try {
      this.retire()
    } catch {
      /* Bookkeeping must not refuse a terminal action. */
    }
  }

  createPty(input: RuntimePtyWorktreeRecord): RuntimePtyWorktreeRecord {
    const record = { ...input }
    this.ownedPtys.set(record, record)
    this.ptyRecords.set(record.ptyId, record)
    this.paneCandidates.setPty(record)
    this.changed()
    return record
  }

  /** `inferredFromCwd` marks a guess that must never drive a worktree-scoped stop (#36716). */
  setPtyWorktree(record: RuntimePtyWorktreeRecord, worktreeId: string, inferredFromCwd: boolean) {
    this.setPtyField(record, 'worktreeId', worktreeId)
    this.setPtyField(record, 'worktreeInferredFromCwd', inferredFromCwd || undefined)
  }

  /** A binding (pane, layout) confirms the recorded worktree, so a cwd guess no longer guards it. */
  confirmPtyWorktree(record: Pick<RuntimePtyWorktreeRecord, 'ptyId'>): void {
    const owned = this.ownedPtys.get(record)
    if (owned?.worktreeInferredFromCwd) {
      delete owned.worktreeInferredFromCwd
      this.changed()
    }
  }

  setPtyIncarnationId(record: RuntimePtyWorktreeRecord, value: string | null): void {
    retireReplacedLaunch(record, value)
    this.setPtyField(record, 'incarnationId', value)
  }

  setPtyConnectionId(record: RuntimePtyWorktreeRecord, value: string | null): void {
    this.setPtyField(record, 'connectionId', value)
  }

  setPtyConnected(record: RuntimePtyWorktreeRecord, value: boolean): void {
    this.setPtyField(record, 'connected', value)
  }

  setPtyTabId(record: RuntimePtyWorktreeRecord, value: string | null | undefined): void {
    this.setPtyField(record, 'tabId', value)
  }

  setPtyIsWsl(record: RuntimePtyWorktreeRecord, value: boolean | null): void {
    this.setPtyField(record, 'isWsl', value)
  }

  setPtyWslDistro(record: RuntimePtyWorktreeRecord, value: string | null): void {
    this.setPtyField(record, 'wslDistro', value)
  }

  setRecordedSurface(
    record: Pick<
      RuntimePtyWorktreeRecord,
      'ptyId' | 'paneKey' | 'tabId' | 'surfaceRecordedAtGraphSequence'
    >,
    tabId: string | null | undefined,
    paneKey: string | null,
    standing: number | undefined
  ): void {
    const owned = this.ownedPtys.get(record)
    if (!owned) {
      return
    }
    const changed =
      (tabId !== undefined && owned.tabId !== tabId) ||
      owned.paneKey !== paneKey ||
      (standing !== undefined && owned.surfaceRecordedAtGraphSequence !== standing)
    if (tabId !== undefined) {
      owned.tabId = tabId
    }
    owned.paneKey = paneKey
    if (standing !== undefined) {
      owned.surfaceRecordedAtGraphSequence = standing
    }
    if (changed) {
      if (this.ptyRecords.get(owned.ptyId) === owned) {
        this.paneCandidates.setPty(owned)
      }
      this.changed()
    }
  }

  removePty(id: string): boolean {
    this.paneCandidates.removePty(id)
    return this.remove(this.ptyRecords, id)
  }

  replaceLeaves(inputs: ReadonlyMap<string, RuntimeLeafRecord>): void {
    if (inputs === this.leafRecords) {
      return
    }
    const next = new Map<string, Mutable<RuntimeLeafRecord>>()
    this.paneCandidates.leaves.clear()
    for (const [key, input] of inputs) {
      const owned = this.ownedLeaves.get(input) ?? { ...input }
      this.ownedLeaves.set(owned, owned)
      next.set(key, owned)
      this.paneCandidates.leaves.set(key, owned.leafId)
    }
    this.leafRecords = next
    this.changed()
  }

  updateLeafConnected(record: RuntimeLeafRecord, connected: boolean): void {
    const owned = this.ownedLeaves.get(record)
    if (owned && owned.connected !== connected) {
      owned.connected = connected
      this.changed()
    }
  }

  removeLeaf(key: string): boolean {
    this.paneCandidates.leaves.delete(key)
    return this.remove(this.leafRecords, key)
  }
  clearLeaves(): void {
    this.paneCandidates.leaves.clear()
    this.clear(this.leafRecords)
  }

  replaceTabs(inputs: readonly RuntimeSyncedTab[]): void {
    this.tabRecords = new Map(inputs.map((tab) => [tab.tabId, structuredClone(tab)]))
    this.changed()
  }
  removeTab(id: string): boolean {
    return this.remove(this.tabRecords, id)
  }
  clearTabs(): void {
    this.clear(this.tabRecords)
  }

  setHandle(key: string, input: TerminalHandleRecord): void {
    const previous = this.handleRecords.get(key)
    const owned = { ...input }
    this.handleRecords.set(key, owned)
    if (
      !previous ||
      previous.handle !== owned.handle ||
      previous.runtimeId !== owned.runtimeId ||
      previous.rendererGraphEpoch !== owned.rendererGraphEpoch ||
      previous.worktreeId !== owned.worktreeId ||
      previous.tabId !== owned.tabId ||
      previous.leafId !== owned.leafId ||
      previous.ptyId !== owned.ptyId ||
      previous.ptyGeneration !== owned.ptyGeneration ||
      previous.issuedForPaneKey !== owned.issuedForPaneKey
    ) {
      this.changed()
    }
  }
  removeHandle(key: string): boolean {
    return this.remove(this.handleRecords, key)
  }
  clearHandles(): void {
    this.clear(this.handleRecords)
  }

  bindPty(id: string, handle: string): void {
    this.reverseCandidates.set(id, handle)
    this.bind(this.ptyBindings, id, handle)
  }
  firstReversePtyId(handle: string): string | undefined {
    return this.reverseCandidates.first(handle)
  }
  clearPtyBindings(): void {
    this.reverseCandidates.clear()
    this.clear(this.ptyBindings)
  }
  unbindPty(id: string): boolean {
    this.reverseCandidates.delete(id)
    return this.remove(this.ptyBindings, id)
  }
  bindLeaf(key: string, handle: string): void {
    this.bind(this.leafBindings, key, handle)
  }
  unbindLeaf(key: string): boolean {
    return this.remove(this.leafBindings, key)
  }
  clearLeafBindings(): void {
    this.clear(this.leafBindings)
  }

  setIncarnation(id: string, input: PtyIncarnationHandleRecord): void {
    this.incarnationSource.setIncarnation(id, input)
  }
  setIncarnationLeaf(record: PtyIncarnationHandleRecord, leafKey: string): void {
    this.incarnationSource.setIncarnationLeaf(record, leafKey)
  }
  setIncarnationProcess(record: PtyIncarnationHandleRecord, incarnationId: string | null): void {
    this.incarnationSource.setIncarnationProcess(record, incarnationId)
  }
  removeIncarnation(id: string): boolean {
    return this.incarnationSource.removeIncarnation(id)
  }
  clearIncarnations(): void {
    this.incarnationSource.clearIncarnations()
  }
  firstIncarnationPtyId(handle: string): string | undefined {
    return this.incarnationSource.firstIncarnationPtyId(handle)
  }

  addSynthetic(handle: string): void {
    if (!this.syntheticHandles.has(handle)) {
      this.syntheticHandles.add(handle)
      this.changed()
    }
  }
  removeSynthetic(handle: string): boolean {
    const removed = this.syntheticHandles.delete(handle)
    if (removed) {
      this.changed()
    }
    return removed
  }
  advanceGraphSequence(): void {
    this.sequence += 1
    this.changed()
  }
  advanceRendererEpoch(): void {
    this.epoch += 1
    this.changed()
  }

  private setPtyField<K extends keyof RuntimePtyWorktreeRecord>(
    record: RuntimePtyWorktreeRecord,
    key: K,
    value: RuntimePtyWorktreeRecord[K]
  ): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned[key] !== value) {
      owned[key] = value
      this.changed()
    }
  }

  private bind(map: Map<string, string>, key: string, value: string): void {
    const previous = map.get(key)
    if (previous !== value) {
      map.set(key, value)
      this.changed()
    }
  }
  private remove<T>(map: Map<string, T>, key: string): boolean {
    const removed = map.delete(key)
    if (removed) {
      this.changed()
    }
    return removed
  }
  private clear<T>(map: Map<string, T>): void {
    if (map.size > 0) {
      map.clear()
      this.changed()
    }
  }
}
