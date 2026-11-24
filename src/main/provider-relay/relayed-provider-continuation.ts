import type { ProviderRelayAckFloor } from './relayed-provider-output'

/**
 * A provider's view of its streamed items, for a replay that starts inside one (the daemon released
 * its kept start at the file cap): it can't be rewritten whole, so its lines go to a continuation row.
 */
export type ProviderRelayItemContinuation = {
  /** The streamed item a line belongs to, and whether the line starts it or ends it. */
  item(line: string): { key: string; start: boolean; end: boolean } | null
  /** The line with its item moved to the continuation named by `tag` (stable across attaches). */
  rekey(line: string, tag: string): string
  /** A start of that continuation, as the ack floor reads one, so it is kept from its first line. */
  start(line: string, tag: string): string
  /**
   * The lines that end a moved item, in place of its end: by default the end, re-keyed. A provider
   * whose end carries the whole item can put it on the saved row and retire the continuation.
   */
  finish?(line: string, tag: string): string[]
  /** The attach's open-work group (keys as the daemon carries them) that every streamed item lives in. */
  openGroup?: string
  /** The key, as JSON, of the open work this line ends, if any. */
  settles?(line: string): string | null
}

/**
 * The items open at an attach that replays from `cutThrough`: each one first seen past that point
 * without its start is re-keyed `relay:<relayId>:<first seq>` for the rest of its life. The first
 * replayed seq is where every later attach replays from, so the tag (and the row) is the same each
 * time. With `open`, lines are read only until all of that work has ended.
 */
export class RelayedProviderContinuation {
  private readonly started = new Set<string>()
  private readonly moved = new Map<string, string>()

  constructor(
    private readonly hook: ProviderRelayItemContinuation,
    private readonly relayId: string,
    private readonly cutThrough: number,
    private readonly open: Set<string> | null = null
  ) {}

  /** Every open work the attach carried has ended; no streamed item outlives it. */
  get done(): boolean {
    return this.open !== null && this.open.size === 0
  }

  /** The lines to hand on for this one: itself, re-keyed, or a moved item's finishing lines. */
  lines(seq: number, line: string, floor: ProviderRelayAckFloor | undefined): string[] {
    if (this.open?.size) {
      const settled = this.hook.settles?.(line)
      if (settled) {
        this.open.delete(settled)
      }
    }
    const item = this.hook.item(line)
    if (!item || seq <= this.cutThrough) {
      return [line]
    }
    if (item.start) {
      this.started.add(item.key)
      return [line]
    }
    let tag = this.moved.get(item.key)
    if (tag === undefined) {
      if (this.started.has(item.key)) {
        return [line]
      }
      tag = `relay:${this.relayId}:${seq}`
      this.moved.set(item.key, tag)
      floor?.observe(seq, this.hook.start(line, tag))
    }
    if (item.end) {
      this.moved.delete(item.key)
      this.started.add(item.key)
      return this.hook.finish?.(line, tag) ?? [this.hook.rekey(line, tag)]
    }
    return [this.hook.rekey(line, tag)]
  }
}
