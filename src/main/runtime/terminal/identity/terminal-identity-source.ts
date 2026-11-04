import type { RuntimeSyncedTab } from '../../../../shared/runtime-types'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import { TerminalIncarnationCandidates } from './terminal-incarnation-candidates'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
/** Canonical terminal facts; semantic operations retain selection, callbacks and failure policy. */
export class TerminalIdentitySource {
  private readonly ptyRecords = new Map<string, Mutable<RuntimePtyWorktreeRecord>>()
  private leafRecords = new Map<string, Mutable<RuntimeLeafRecord>>()
  private tabRecords = new Map<string, Readonly<RuntimeSyncedTab>>()
  private readonly handleRecords = new Map<string, TerminalHandleRecord>()
  private readonly ptyBindings = new Map<string, string>()
  private readonly leafBindings = new Map<string, string>()
  private readonly incarnationBindings = new Map<string, Mutable<PtyIncarnationHandleRecord>>()
  private readonly incarnationCandidates = new TerminalIncarnationCandidates()
  private readonly syntheticHandles = new Set<string>()
  // Weak ownership links preserve detached canonical records without retaining their lifetime.
  private readonly ownedPtys = new WeakMap<object, Mutable<RuntimePtyWorktreeRecord>>()
  private readonly ownedLeaves = new WeakMap<RuntimeLeafRecord, Mutable<RuntimeLeafRecord>>()
  private readonly ownedIncarnations = new WeakMap<
    PtyIncarnationHandleRecord,
    Mutable<PtyIncarnationHandleRecord>
  >()
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
  readonly incarnations: ReadonlyMap<string, PtyIncarnationHandleRecord> = this.incarnationBindings
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
    this.changed()
    return record
  }

  setPtyWorktreeId(record: RuntimePtyWorktreeRecord, value: string): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.worktreeId !== value) {
      owned.worktreeId = value
      this.changed()
    }
  }

  setPtyIncarnationId(record: RuntimePtyWorktreeRecord, value: string | null): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.incarnationId !== value) {
      owned.incarnationId = value
      this.changed()
    }
  }

  setPtyConnectionId(record: RuntimePtyWorktreeRecord, value: string | null): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.connectionId !== value) {
      owned.connectionId = value
      this.changed()
    }
  }

  setPtyConnected(record: RuntimePtyWorktreeRecord, value: boolean): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.connected !== value) {
      owned.connected = value
      this.changed()
    }
  }

  setPtyTabId(record: RuntimePtyWorktreeRecord, value: string | null | undefined): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.tabId !== value) {
      owned.tabId = value
      this.changed()
    }
  }

  setPtyIsWsl(record: RuntimePtyWorktreeRecord, value: boolean | null): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.isWsl !== value) {
      owned.isWsl = value
      this.changed()
    }
  }

  setPtyWslDistro(record: RuntimePtyWorktreeRecord, value: string | null): void {
    const owned = this.ownedPtys.get(record)
    if (owned && owned.wslDistro !== value) {
      owned.wslDistro = value
      this.changed()
    }
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
      this.changed()
    }
  }

  removePty(id: string): boolean {
    return this.remove(this.ptyRecords, id)
  }

  replaceLeaves(inputs: ReadonlyMap<string, RuntimeLeafRecord>): void {
    if (inputs === this.leafRecords) {
      return
    }
    const next = new Map<string, Mutable<RuntimeLeafRecord>>()
    for (const [key, input] of inputs) {
      const owned = this.ownedLeaves.get(input) ?? { ...input }
      this.ownedLeaves.set(owned, owned)
      next.set(key, owned)
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
    return this.remove(this.leafRecords, key)
  }
  clearLeaves(): void {
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
    this.bind(this.ptyBindings, id, handle)
  }
  clearPtyBindings(): void {
    this.clear(this.ptyBindings)
  }
  unbindPty(id: string): boolean {
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
    const previous = this.incarnationBindings.get(id)
    const owned = { ...input }
    this.ownedIncarnations.set(owned, owned)
    this.incarnationBindings.set(id, owned)
    this.incarnationCandidates.set(id, owned.handle)
    if (
      !previous ||
      previous.handle !== owned.handle ||
      previous.incarnationId !== owned.incarnationId ||
      previous.leafKey !== owned.leafKey
    ) {
      this.changed()
    }
  }
  setIncarnationLeaf(record: PtyIncarnationHandleRecord, leafKey: string): void {
    const owned = this.ownedIncarnations.get(record)
    if (owned && owned.leafKey !== leafKey) {
      owned.leafKey = leafKey
      this.changed()
    }
  }
  setIncarnationProcess(record: PtyIncarnationHandleRecord, incarnationId: string | null): void {
    const owned = this.ownedIncarnations.get(record)
    if (owned && owned.incarnationId !== incarnationId) {
      owned.incarnationId = incarnationId
      this.changed()
    }
  }
  removeIncarnation(id: string): boolean {
    this.incarnationCandidates.delete(id)
    return this.remove(this.incarnationBindings, id)
  }
  clearIncarnations(): void {
    this.incarnationCandidates.clear()
    this.clear(this.incarnationBindings)
  }
  firstIncarnationPtyId(handle: string): string | undefined {
    return this.incarnationCandidates.first(handle)
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
