import type { AdmissionWaiter } from './git-admission-state'

export type WaiterLane = {
  items: AdmissionWaiter[]
  head: number
  count: number
  baseEligible: boolean
  headroomEligible: boolean
  version: number
}

export type Candidate = { lane: WaiterLane; waiter: AdmissionWaiter; version: number }

const CANDIDATE_HEAP_COMPACTION_SLACK = 64

export class CandidateHeap {
  private items: Candidate[] = []

  get size(): number {
    return this.items.length
  }

  push(candidate: Candidate): void {
    this.items.push(candidate)
    let index = this.items.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.items[parent].waiter.id <= candidate.waiter.id) {
        break
      }
      this.items[index] = this.items[parent]
      index = parent
    }
    this.items[index] = candidate
  }

  peek(valid: (candidate: Candidate) => boolean): Candidate | null {
    // Eligibility changes invalidate by version so route updates stay O(log N).
    while (this.items.length > 0 && !valid(this.items[0])) {
      this.pop()
    }
    return this.items[0] ?? null
  }

  compactIfOversized(maxLiveCandidates: number, valid: (candidate: Candidate) => boolean): void {
    if (this.items.length <= maxLiveCandidates * 2 + CANDIDATE_HEAP_COMPACTION_SLACK) {
      return
    }
    this.items = this.items.filter(valid)
    for (let index = Math.floor(this.items.length / 2) - 1; index >= 0; index -= 1) {
      this.siftDown(index)
    }
  }

  private pop(): void {
    const last = this.items.pop()
    if (!last || this.items.length === 0) {
      return
    }
    this.items[0] = last
    this.siftDown(0)
  }

  private siftDown(index: number): void {
    const candidate = this.items[index]
    let cursor = index
    while (true) {
      const left = cursor * 2 + 1
      if (left >= this.items.length) {
        break
      }
      const right = left + 1
      const child =
        right < this.items.length && this.items[right].waiter.id < this.items[left].waiter.id
          ? right
          : left
      if (this.items[child].waiter.id >= candidate.waiter.id) {
        break
      }
      this.items[cursor] = this.items[child]
      cursor = child
    }
    this.items[cursor] = candidate
  }
}
