import type { AdmissionClass, AdmissionSlotKind, AdmissionWaiter } from './git-admission-state'
import { CandidateHeap, type Candidate, type WaiterLane } from './git-admission-candidate-heap'
import type { GitAdmissionTier } from './git-exec-options'

type SelectedWaiter = {
  waiter: AdmissionWaiter
  slotKind: AdmissionSlotKind
}

const TIERS = ['interactive', 'status', 'background'] as const
const createLane = (): WaiterLane => ({
  items: [],
  head: 0,
  count: 0,
  baseEligible: false,
  headroomEligible: false,
  version: 0
})
type TierLanes = Record<GitAdmissionTier, Map<string | null, WaiterLane>>
const createTierLanes = (): TierLanes => ({
  interactive: new Map(),
  status: new Map(),
  background: new Map()
})
export class GitAdmissionWaiterQueue {
  private readonly lanes: Record<AdmissionClass, TierLanes> = {
    general: createTierLanes(),
    network: createTierLanes()
  }
  private readonly countsByBudget = new Map<string, number>()
  private readonly baseCandidates: Record<AdmissionClass, Record<GitAdmissionTier, CandidateHeap>> =
    {
      general: {
        interactive: new CandidateHeap(),
        status: new CandidateHeap(),
        background: new CandidateHeap()
      },
      network: {
        interactive: new CandidateHeap(),
        status: new CandidateHeap(),
        background: new CandidateHeap()
      }
    }
  private readonly headroomCandidates: Record<AdmissionClass, CandidateHeap> = {
    general: new CandidateHeap(),
    network: new CandidateHeap()
  }
  private totalCount = 0

  get count(): number {
    return this.totalCount
  }

  /** @internal - exposed for bounded-storage regression tests only. */
  get candidateCountForTests(): number {
    let count = this.headroomCandidates.general.size + this.headroomCandidates.network.size
    for (const admissionClass of ['general', 'network'] as const) {
      for (const tier of TIERS) {
        count += this.baseCandidates[admissionClass][tier].size
      }
    }
    return count
  }

  enqueue(waiter: AdmissionWaiter): void {
    const lanes = this.lanes[waiter.admissionClass][waiter.tier]
    let lane = lanes.get(waiter.route)
    if (!lane) {
      lane = createLane()
      lanes.set(waiter.route, lane)
    }
    lane.items.push(waiter)
    lane.count += 1
    this.totalCount += 1
    for (const key of waiter.budgetKeys) {
      this.countsByBudget.set(key, (this.countsByBudget.get(key) ?? 0) + 1)
    }
    if (lane.count === 1) {
      this.publishLaneHead(waiter.admissionClass, waiter.tier, lane)
    }
  }

  dequeue(waiter: AdmissionWaiter): void {
    const lanes = this.lanes[waiter.admissionClass][waiter.tier]
    const lane = lanes.get(waiter.route)
    if (!lane) {
      return
    }
    lane.count -= 1
    this.totalCount -= 1
    for (const key of waiter.budgetKeys) {
      const current = this.countsByBudget.get(key)
      if (current === 1) {
        this.countsByBudget.delete(key)
      } else if (current !== undefined) {
        this.countsByBudget.set(key, current - 1)
      }
    }
    const previousHead = lane.items[lane.head]
    this.compact(lane)
    if (lane.count === 0) {
      lane.version += 1
      lanes.delete(waiter.route)
      this.compactCandidateHeaps(waiter.admissionClass, waiter.tier)
    } else if (lane.items[lane.head] !== previousHead) {
      lane.version += 1
      this.publishLaneHead(waiter.admissionClass, waiter.tier, lane)
      this.compactCandidateHeaps(waiter.admissionClass, waiter.tier)
    }
  }

  updateRouteEligibility(
    admissionClass: AdmissionClass,
    route: string | null,
    baseEligible: boolean,
    headroomEligible: boolean
  ): void {
    for (const tier of TIERS) {
      const lane = this.lanes[admissionClass][tier].get(route)
      if (
        !lane ||
        (lane.baseEligible === baseEligible && lane.headroomEligible === headroomEligible)
      ) {
        continue
      }
      lane.baseEligible = baseEligible
      lane.headroomEligible = headroomEligible
      lane.version += 1
      this.publishLaneHead(admissionClass, tier, lane)
      this.compactCandidateHeaps(admissionClass, tier)
    }
  }

  hasBudget(key: string): boolean {
    return this.countsByBudget.has(key)
  }

  snapshot(): AdmissionWaiter[] {
    return (['general', 'network'] as const)
      .flatMap((admissionClass) =>
        TIERS.flatMap((tier) => {
          return [...this.lanes[admissionClass][tier].values()].flatMap((lane) =>
            lane.items.slice(lane.head).filter((waiter) => waiter.state === 'queued')
          )
        })
      )
      .sort((left, right) => left.id - right.id)
  }

  nextFitting(
    admissionClass: AdmissionClass,
    effectiveTier: (waiter: AdmissionWaiter) => number,
    allowBase: boolean,
    allowHeadroom: boolean,
    abort: (waiter: AdmissionWaiter) => void
  ): SelectedWaiter | null {
    while (true) {
      const candidates: SelectedWaiter[] = []
      if (allowBase) {
        // Aging preserves order within a raw tier, so only its oldest eligible head can win.
        for (const tier of TIERS) {
          const candidate = this.peekValid(this.baseCandidates[admissionClass][tier], 'base')
          if (candidate) {
            candidates.push({ waiter: candidate.waiter, slotKind: 'base' })
          }
        }
      }
      if (allowHeadroom) {
        const candidate = this.peekValid(this.headroomCandidates[admissionClass], 'headroom')
        if (candidate) {
          candidates.push({ waiter: candidate.waiter, slotKind: 'headroom' })
        }
      }
      const selected = candidates.sort(
        (left, right) =>
          effectiveTier(left.waiter) - effectiveTier(right.waiter) ||
          left.waiter.id - right.waiter.id ||
          (left.slotKind === 'base' ? -1 : 1)
      )[0]
      if (!selected || !selected.waiter.signal?.aborted) {
        return selected ?? null
      }
      abort(selected.waiter)
    }
  }

  private publishLaneHead(
    admissionClass: AdmissionClass,
    tier: GitAdmissionTier,
    lane: WaiterLane
  ): void {
    const waiter = lane.items[lane.head]
    if (!waiter || waiter.state !== 'queued') {
      return
    }
    const candidate = { lane, waiter, version: lane.version }
    if (lane.baseEligible) {
      this.baseCandidates[admissionClass][tier].push(candidate)
    }
    if (tier === 'interactive' && lane.headroomEligible) {
      this.headroomCandidates[admissionClass].push(candidate)
    }
  }

  private peekValid(heap: CandidateHeap, slotKind: AdmissionSlotKind): Candidate | null {
    return heap.peek((candidate) => this.candidateIsValid(candidate, slotKind))
  }

  private candidateIsValid(candidate: Candidate, slotKind: AdmissionSlotKind): boolean {
    const { lane, waiter, version } = candidate
    return (
      version === lane.version &&
      waiter === lane.items[lane.head] &&
      waiter.state === 'queued' &&
      (slotKind === 'base' ? lane.baseEligible : lane.headroomEligible)
    )
  }

  private compactCandidateHeaps(admissionClass: AdmissionClass, tier: GitAdmissionTier): void {
    const liveLaneCount = this.lanes[admissionClass][tier].size
    this.baseCandidates[admissionClass][tier].compactIfOversized(liveLaneCount, (candidate) =>
      this.candidateIsValid(candidate, 'base')
    )
    if (tier === 'interactive') {
      this.headroomCandidates[admissionClass].compactIfOversized(liveLaneCount, (candidate) =>
        this.candidateIsValid(candidate, 'headroom')
      )
    }
  }

  private compact(lane: WaiterLane): void {
    let head = lane.head
    while (head < lane.items.length && lane.items[head].state !== 'queued') {
      head += 1
    }
    lane.head = head
    if (lane.count === 0) {
      lane.items.length = 0
      lane.head = 0
      return
    }
    const tombstones = lane.items.length - head - lane.count
    if (head < 256 && (lane.items.length < 256 || tombstones <= lane.count)) {
      return
    }
    lane.items = lane.items.slice(head).filter((candidate) => candidate.state === 'queued')
    lane.head = 0
  }
}
