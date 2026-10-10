/**
 * Main parses a local daemon PTY only while something needs main's own model (#27023).
 *
 * The daemon parses every byte and serves settled, seq-stamped snapshots, and a visible
 * renderer parses the same bytes to paint them. Main's emulator matters only when main
 * answers a hidden pane's queries, a subscriber or screen reader needs it, or an agent is
 * watched. While none of that holds, main drops it; any demand rebuilds it from the
 * daemon snapshot, and live bytes the snapshot already covers are skipped.
 */

export const MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS = 5_000
// Why: bytes the snapshot counted can still be in flight on the stream socket; the gate
// stays open until they arrive, but a stalled stream must not keep it open forever.
export const MAIN_TERMINAL_MODEL_HANDOFF_CATCH_UP_MS = 2_000

export type MainTerminalModelDormancyHost = {
  now(): number
  lifecycleGeneration(ptyId: string): number
  outputSequence(ptyId: string): number
  /** Nothing needs main's model, and the model (if any) has applied every byte through `ingestedSeq`. */
  isModelIdle(ptyId: string, ingestedSeq: number): boolean
  /** Drops main's model; the daemon and the visible renderer keep parsing. */
  dropModel(ptyId: string): void
  /** Rebuilds main's model from the daemon snapshot; reports back via seedSettled/seedFailed. */
  materializeModel(ptyId: string): void
  /** While pending, the hidden-delivery gate keeps feeding the renderer, so main never owes a
   *  query reply for a byte its new model skipped as already covered. */
  setHandoffPending(ptyId: string, pending: boolean): void
}

type Handoff = { seedSeq: number | null; timer: ReturnType<typeof setTimeout> | null }

type DormancyEntry = {
  generation: number
  dormant: boolean
  everDormant: boolean
  pinnedLive: boolean
  lastDemandAt: number
  handoff: Handoff | null
}

export class MainTerminalModelDormancy {
  private readonly entries = new Map<string, DormancyEntry>()
  // Why outside the entries: a reader outlives a PTY generation and must hold across a respawn.
  private readonly pins = new Map<string, number>()

  constructor(private readonly host: MainTerminalModelDormancyHost) {}

  /** Per live chunk, before reply ownership is captured. True when main skips its model for it. */
  onChunk(ptyId: string, chunkStartSeq: number): boolean {
    const entry = this.entryFor(ptyId)
    const handoff = entry.handoff
    if (handoff?.seedSeq != null && chunkStartSeq >= handoff.seedSeq) {
      this.finishHandoff(ptyId, entry)
    }
    const idle = !this.pins.has(ptyId) && this.host.isModelIdle(ptyId, chunkStartSeq)
    const now = this.host.now()
    if (entry.dormant) {
      if (idle) {
        return true
      }
      this.wake(ptyId, entry)
      return false
    }
    if (!idle || entry.pinnedLive || entry.handoff) {
      entry.lastDemandAt = now
      return false
    }
    if (now - entry.lastDemandAt < MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS) {
      return false
    }
    entry.dormant = true
    entry.everDormant = true
    this.host.dropModel(ptyId)
    return true
  }

  /** A reader or a hidden mark needs main's model now. */
  noteDemand(ptyId: string): void {
    const entry = this.currentEntry(ptyId)
    if (!entry) {
      return
    }
    entry.lastDemandAt = this.host.now()
    if (entry.dormant) {
      this.wake(ptyId, entry)
    }
  }

  /** Keeps main's model live until the returned release runs; releasing restarts the grace period. */
  pin(ptyId: string): () => void {
    this.pins.set(ptyId, (this.pins.get(ptyId) ?? 0) + 1)
    this.noteDemand(ptyId)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.pins.get(ptyId) ?? 1) - 1
      if (remaining > 0) {
        this.pins.set(ptyId, remaining)
      } else {
        this.pins.delete(ptyId)
      }
      this.noteDemand(ptyId)
    }
  }

  hasReaders(ptyId: string): boolean {
    return this.pins.has(ptyId)
  }

  /** Main's model has applied every ingested byte: it never went dormant, or its rebuild caught up. */
  isCaughtUp(ptyId: string): boolean {
    const entry = this.currentEntry(ptyId)
    return !entry || (!entry.dormant && entry.handoff === null)
  }

  /** A caller is seeding main's model itself; stop treating the PTY as dormant. */
  cancelDormancy(ptyId: string): void {
    const entry = this.currentEntry(ptyId)
    if (entry) {
      entry.dormant = false
      entry.lastDemandAt = this.host.now()
    }
  }

  isDormant(ptyId: string): boolean {
    return this.currentEntry(ptyId)?.dormant === true
  }

  /** Main's model for this PTY started (or will start) from a bounded daemon seed, so a
   *  full-depth restore must come from the daemon. */
  wasEverDormant(ptyId: string): boolean {
    return this.currentEntry(ptyId)?.everDormant === true
  }

  seedSettled(ptyId: string, seedSeq: number): void {
    const entry = this.currentEntry(ptyId)
    const handoff = entry?.handoff
    if (!entry || !handoff) {
      return
    }
    handoff.seedSeq = seedSeq
    if (this.host.outputSequence(ptyId) >= seedSeq) {
      this.finishHandoff(ptyId, entry)
      return
    }
    handoff.timer = setTimeout(() => {
      if (this.currentEntry(ptyId)?.handoff === handoff) {
        this.finishHandoff(ptyId, entry)
      }
    }, MAIN_TERMINAL_MODEL_HANDOFF_CATCH_UP_MS)
    handoff.timer.unref?.()
  }

  /** Keeps main's model live for the rest of this PTY generation. */
  seedFailed(ptyId: string): void {
    const entry = this.currentEntry(ptyId)
    if (!entry) {
      return
    }
    entry.pinnedLive = true
    if (entry.handoff) {
      this.finishHandoff(ptyId, entry)
    }
  }

  forget(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) {
      return
    }
    if (entry.handoff) {
      this.finishHandoff(ptyId, entry)
    }
    this.entries.delete(ptyId)
  }

  private wake(ptyId: string, entry: DormancyEntry): void {
    entry.dormant = false
    entry.lastDemandAt = this.host.now()
    if (!entry.handoff) {
      entry.handoff = { seedSeq: null, timer: null }
      this.host.setHandoffPending(ptyId, true)
    }
    try {
      this.host.materializeModel(ptyId)
    } catch {
      this.seedFailed(ptyId)
    }
  }

  private finishHandoff(ptyId: string, entry: DormancyEntry): void {
    if (entry.handoff?.timer) {
      clearTimeout(entry.handoff.timer)
    }
    entry.handoff = null
    this.host.setHandoffPending(ptyId, false)
  }

  private currentEntry(ptyId: string): DormancyEntry | null {
    const entry = this.entries.get(ptyId)
    if (!entry) {
      return null
    }
    if (entry.generation !== this.host.lifecycleGeneration(ptyId)) {
      this.forget(ptyId)
      return null
    }
    return entry
  }

  private entryFor(ptyId: string): DormancyEntry {
    const current = this.currentEntry(ptyId)
    if (current) {
      return current
    }
    const entry: DormancyEntry = {
      generation: this.host.lifecycleGeneration(ptyId),
      dormant: false,
      everDormant: false,
      pinnedLive: false,
      lastDemandAt: this.host.now(),
      handoff: null
    }
    this.entries.set(ptyId, entry)
    return entry
  }
}

/** The part of a live chunk that a seed taken at `seedSeq` has not already applied. Null when
 *  a transformed chunk straddles the seed, since raw offsets cannot split it. */
export function chunkDataAfterSeed(
  data: string,
  endSeq: number,
  rawLength: number,
  seedSeq: number
): string | null {
  if (endSeq <= seedSeq) {
    return ''
  }
  const startSeq = endSeq - rawLength
  if (startSeq >= seedSeq) {
    return data
  }
  if (rawLength !== data.length) {
    return null
  }
  return data.slice(seedSeq - startSeq)
}
