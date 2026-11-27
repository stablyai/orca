import type { CodexSharedServerFrame } from './codex-shared-server-frames'

/** A frame recovery holds; `gone` once it was taken or dropped. */
export type CodexRecoveryHeld = { frame: CodexSharedServerFrame; bytes: number; gone: boolean }

const COMPACTION_SLACK = 64

/**
 * The lowest seq recovery still holds, as a heap of its held frames: the ack floor is a peek, never
 * a scan of every chat's group. Frames that left are popped when they reach the top, and the heap
 * is rebuilt once they outnumber the live ones.
 */
export class CodexRecoverySeqFloor {
  private items: CodexRecoveryHeld[] = []
  private live = 0

  add(held: CodexRecoveryHeld): void {
    if (typeof held.frame.seq !== 'number') {
      return
    }
    this.live += 1
    this.items.push(held)
    this.siftUp(this.items.length - 1)
  }

  gone(held: CodexRecoveryHeld): void {
    if (held.gone) {
      return
    }
    held.gone = true
    if (typeof held.frame.seq !== 'number') {
      return
    }
    this.live -= 1
    if (this.items.length > this.live * 2 + COMPACTION_SLACK) {
      this.items = this.items.filter((item) => !item.gone)
      for (let at = Math.floor(this.items.length / 2) - 1; at >= 0; at -= 1) {
        this.siftDown(at)
      }
    }
  }

  floor(): number | null {
    while (this.items[0]?.gone) {
      this.pop()
    }
    return this.items[0]?.frame.seq ?? null
  }

  clear(): void {
    this.items = []
    this.live = 0
  }

  private seq(at: number): number {
    return this.items[at]!.frame.seq!
  }

  private pop(): void {
    const last = this.items.pop()
    if (last && this.items.length > 0) {
      this.items[0] = last
      this.siftDown(0)
    }
  }

  private siftUp(at: number): void {
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (this.seq(parent) <= this.seq(at)) {
        return
      }
      this.swap(at, parent)
      at = parent
    }
  }

  private siftDown(at: number): void {
    for (;;) {
      const left = at * 2 + 1
      const right = left + 1
      let least = at
      if (left < this.items.length && this.seq(left) < this.seq(least)) {
        least = left
      }
      if (right < this.items.length && this.seq(right) < this.seq(least)) {
        least = right
      }
      if (least === at) {
        return
      }
      this.swap(at, least)
      at = least
    }
  }

  private swap(a: number, b: number): void {
    const held = this.items[a]!
    this.items[a] = this.items[b]!
    this.items[b] = held
  }
}
