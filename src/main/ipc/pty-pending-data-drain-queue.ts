import type * as Contract from './pty-pending-data-drain-contract'

export type * from './pty-pending-data-drain-contract'

type LinkedLaneName = Contract.PtyPendingDataDrainDisposition
type NodeLaneName = LinkedLaneName | 'none' | 'selected'

type PendingNode = {
  id: string
  allocationId: number
  pending: Contract.PendingPtyData
  previous: PendingNode | null
  next: PendingNode | null
  lane: NodeLaneName
  lanePosition: number
  eligibleRound: number
}

type Lane = { head: PendingNode | null; tail: PendingNode | null; size: number }

function createLane(): Lane {
  return { head: null, tail: null, size: 0 }
}

export class PtyPendingDataDrainQueue {
  private readonly nodes = new Map<string, PendingNode>()
  private readonly active = createLane()
  private readonly background = createLane()
  private readonly blocked = createLane()
  private roundSerial = 0
  private lanePositionSerial = 0
  private openRound: Contract.PtyPendingDataDrainRound | null = null
  private selectedNode: PendingNode | null = null
  private relinkPending = false
  private createdNodeCount = 0
  private peakNodeCount = 0
  private selectionVisitCount = 0
  private laneRebuildCount = 0
  private pendingChars = 0
  private lastPolicyToken: unknown

  constructor(
    private readonly classify: (id: string) => Contract.PtyPendingDataDrainDisposition,
    private readonly readPolicyToken?: () => unknown
  ) {
    this.lastPolicyToken = readPolicyToken?.()
  }

  get size(): number {
    return this.nodes.size
  }

  get totalPendingChars(): number {
    return this.pendingChars
  }

  get(id: string): Contract.PendingPtyData | undefined {
    return this.nodes.get(id)?.pending
  }

  keys(): IterableIterator<string> {
    return this.nodes.keys()
  }

  *values(): IterableIterator<Contract.PendingPtyData> {
    for (const node of this.nodes.values()) {
      yield node.pending
    }
  }

  set(id: string, pending: Contract.PendingPtyData): void {
    const existing = this.nodes.get(id)
    if (!existing) {
      const node: PendingNode = {
        id,
        allocationId: this.createdNodeCount + 1,
        pending,
        previous: null,
        next: null,
        lane: 'none',
        lanePosition: 0,
        eligibleRound: this.roundSerial + 1
      }
      this.nodes.set(id, node)
      this.pendingChars += pending.data.length
      this.createdNodeCount += 1
      this.peakNodeCount = Math.max(this.peakNodeCount, this.nodes.size)
      this.appendToLane(node, this.classify(id))
      return
    }

    if (existing === this.selectedNode) {
      throw new Error('Selected PTY pending data must commit before update')
    }
    this.pendingChars += pending.data.length - existing.pending.data.length
    existing.pending = pending
    if (this.openRound) {
      // Why: renderer notification can synchronously append; defer the whole ID past this round's frontier.
      this.unlink(existing)
      existing.eligibleRound = this.openRound.round + 1
      this.appendToLane(existing, this.classify(id))
      this.relinkPending = true
    }
  }

  delete(id: string): Contract.PendingPtyData | undefined {
    const node = this.nodes.get(id)
    if (!node) {
      return undefined
    }
    this.nodes.delete(id)
    this.pendingChars -= node.pending.data.length
    this.unlink(node)
    if (this.selectedNode === node) {
      this.selectedNode = null
    }
    return node.pending
  }

  clear(): void {
    if (this.openRound) {
      this.openRound.aborted = true
    }
    this.nodes.clear()
    this.pendingChars = 0
    this.resetLane(this.active)
    this.resetLane(this.background)
    this.resetLane(this.blocked)
    this.openRound = null
    this.selectedNode = null
    this.relinkPending = false
    this.lanePositionSerial = 0
  }

  invalidateAll(): boolean {
    return this.requestRelink(this.nodes.size > 0)
  }

  invalidate(id: string): boolean {
    return this.requestRelink(this.nodes.has(id))
  }

  reactivateBlocked(): boolean {
    return this.requestRelink(this.blocked.size > 0)
  }

  beginRound(): Contract.PtyPendingDataDrainRound {
    if (this.openRound) {
      throw new Error('PTY pending-data drain round already open')
    }
    this.roundSerial += 1
    const policyToken = this.readPolicyToken?.()
    if (!Object.is(policyToken, this.lastPolicyToken)) {
      this.lastPolicyToken = policyToken
      this.requestRelink(this.nodes.size > 0)
    }
    if (this.relinkPending) {
      this.rebuildLanes()
    }
    const round: Contract.PtyPendingDataDrainRound = {
      round: this.roundSerial,
      activeFrontier: this.active.tail?.lanePosition ?? 0,
      backgroundFrontier: this.background.tail?.lanePosition ?? 0,
      phase: 'active',
      aborted: false
    }
    this.openRound = round
    return round
  }

  takeNext(round: Contract.PtyPendingDataDrainRound): Contract.PtyPendingDataDrainSelection | null {
    if (this.openRound !== round || round.aborted || round.phase === 'done') {
      return null
    }
    if (this.selectedNode) {
      throw new Error('PTY pending-data selection must be committed before advancing')
    }

    while (round.phase !== 'done') {
      const lane = round.phase === 'active' ? this.active : this.background
      const frontier = round.phase === 'active' ? round.activeFrontier : round.backgroundFrontier
      const node = lane.head
      if (!node || node.lanePosition > frontier || node.eligibleRound > round.round) {
        round.phase = round.phase === 'active' ? 'background' : 'done'
        continue
      }
      this.unlink(node)
      node.lane = 'selected'
      this.selectedNode = node
      this.selectionVisitCount += 1
      return node
    }
    return null
  }

  block(selection: Contract.PtyPendingDataDrainSelection): void {
    const node = this.requireSelectedNode(selection)
    this.selectedNode = null
    this.appendToLane(node, 'blocked')
  }

  remove(selection: Contract.PtyPendingDataDrainSelection): void {
    const node = this.requireSelectedNode(selection)
    this.selectedNode = null
    this.nodes.delete(node.id)
    this.pendingChars -= node.pending.data.length
    node.lane = 'none'
  }

  replaceWithRemainder(
    selection: Contract.PtyPendingDataDrainSelection,
    pending: Contract.PendingPtyData
  ): void {
    const node = this.requireSelectedNode(selection)
    this.selectedNode = null
    this.nodes.delete(node.id)
    this.pendingChars += pending.data.length - node.pending.data.length
    node.pending = pending
    node.eligibleRound = (this.openRound?.round ?? this.roundSerial) + 1
    this.nodes.set(node.id, node)
    this.appendToLane(node, this.classify(node.id))
  }

  endRound(round: Contract.PtyPendingDataDrainRound): void {
    if (this.openRound !== round) {
      return
    }
    if (this.selectedNode) {
      const selected = this.selectedNode
      this.selectedNode = null
      selected.eligibleRound = round.round + 1
      this.appendToLane(selected, this.classify(selected.id))
      this.relinkPending = true
    }
    this.openRound = null
  }

  getDebugSnapshot() {
    return {
      pendingSize: this.nodes.size,
      totalPendingChars: this.pendingChars,
      activeRunnableSize: this.active.size,
      backgroundRunnableSize: this.background.size,
      blockedSize: this.blocked.size,
      activeHeadId: this.active.head?.id ?? null,
      activeTailId: this.active.tail?.id ?? null,
      backgroundHeadId: this.background.head?.id ?? null,
      backgroundTailId: this.background.tail?.id ?? null,
      blockedHeadId: this.blocked.head?.id ?? null,
      blockedTailId: this.blocked.tail?.id ?? null,
      openRound: this.openRound?.round ?? null,
      activeFrontier: this.openRound?.activeFrontier ?? 0,
      backgroundFrontier: this.openRound?.backgroundFrontier ?? 0,
      createdNodeCount: this.createdNodeCount,
      peakNodeCount: this.peakNodeCount,
      selectionVisitCount: this.selectionVisitCount,
      laneRebuildCount: this.laneRebuildCount,
      allocationIdsByPty: Object.fromEntries(
        Array.from(this.nodes, ([id, node]) => [id, node.allocationId])
      )
    }
  }

  private requireSelectedNode(selection: Contract.PtyPendingDataDrainSelection): PendingNode {
    const node = selection as PendingNode
    if (this.selectedNode !== node || this.nodes.get(node.id) !== node) {
      throw new Error('Stale PTY pending-data drain selection')
    }
    return node
  }

  private requestRelink(needed: boolean): boolean {
    this.relinkPending ||= needed
    return needed
  }

  private rebuildLanes(): void {
    this.laneRebuildCount += 1
    this.resetLane(this.active)
    this.resetLane(this.background)
    this.resetLane(this.blocked)
    for (const node of this.nodes.values()) {
      Object.assign(node, { previous: null, next: null, lane: 'none' as const })
      node.eligibleRound = this.roundSerial
      this.appendToLane(node, this.classify(node.id))
    }
    this.relinkPending = false
  }

  private laneFor(name: LinkedLaneName): Lane {
    return name === 'active' ? this.active : name === 'background' ? this.background : this.blocked
  }

  private appendToLane(node: PendingNode, name: LinkedLaneName): void {
    const lane = this.laneFor(name)
    node.previous = lane.tail
    node.next = null
    node.lane = name
    if (name !== 'blocked') {
      this.lanePositionSerial += 1
      node.lanePosition = this.lanePositionSerial
    }
    if (lane.tail) {
      lane.tail.next = node
    } else {
      lane.head = node
    }
    lane.tail = node
    lane.size += 1
  }

  private unlink(node: PendingNode): void {
    if (node.lane === 'none' || node.lane === 'selected') {
      Object.assign(node, { previous: null, next: null, lane: 'none' as const })
      return
    }
    const lane = this.laneFor(node.lane)
    if (node.previous) {
      node.previous.next = node.next
    } else {
      lane.head = node.next
    }
    if (node.next) {
      node.next.previous = node.previous
    } else {
      lane.tail = node.previous
    }
    lane.size -= 1
    Object.assign(node, { previous: null, next: null, lane: 'none' as const })
  }

  private resetLane(lane: Lane): void {
    Object.assign(lane, { head: null, tail: null, size: 0 })
  }
}
