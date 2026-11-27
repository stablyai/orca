import {
  RELAY_CUT_KEYS_OVERFLOW,
  type ProviderRelayAttachResult
} from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayAckFloor } from './relayed-provider-output'

/**
 * A provider's view of its streamed items, for a replay that starts inside one (the daemon released
 * its kept start at the file cap): it can't be rewritten whole, so its lines go to a continuation row.
 */
export type ProviderRelayItemContinuation = {
  /** The streamed item a line belongs to, and whether the line starts it or ends it. `follows`:
   *  a line that may also be a whole item by itself, so an item seen only through such lines
   *  holds the continuation open no longer than its replay. */
  item(line: string): { key: string; start: boolean; end: boolean; follows?: boolean } | null
  /** The line with its item moved to the continuation named by `tag` (stable across attaches). */
  rekey(line: string, tag: string): string
  /** A start of that continuation, as the ack floor reads one, so it is kept from its first line. */
  start(line: string, tag: string): string
  /**
   * The lines that end a moved item, in place of its end: by default the end, re-keyed. A provider
   * whose end carries the whole item can put it on the saved row and retire the continuation.
   */
  finish?(line: string, tag: string): string[]
  /** The attach's open-work groups (keys as the daemon carries them) every streamed item lives in. */
  openGroup?: string | readonly string[]
  /** The open work, keys as JSON, a provider reads from the attach itself (used for `openGroup`'s);
   *  null: none, so only a daemon cut engages the continuation. */
  openAt?(result: ProviderRelayAttachResult): string[] | null
  /** Whether a cut-named item not yet seen may still resume under the attach's open work (read
   *  after `openAt`); without it, every named item is awaited. */
  awaits?(key: string): boolean
  /** The key, as JSON, of the open work this line ends, if any. */
  settles?(line: string): string | null
  /** A moved item may still resume though no open work was carried (an agent-started turn). */
  mayResume?(): boolean
}

/** With no work open, a moved item this many lines quiet has ended. */
const MOVED_QUIET_LINES = 256

/**
 * The items open at an attach that replays from `cutThrough`: each one first seen past that point
 * without its start is re-keyed `relay:<relayId>:<first seq>` for the rest of its life. The first
 * replayed seq is where every later attach replays from, so the tag (and the row) is the same each
 * time. With `open`, lines are read only until all of that work has ended. With `cutKeys` (the
 * items the cut ack named), exactly those move (all, after the overflow key); without, any item seen without its start does.
 */
export class RelayedProviderContinuation {
  private readonly started = new Set<string>()
  private readonly moved = new Map<string, string>()
  /** Named items not yet seen: one may resume after the replay, while its open work runs. */
  private readonly awaited: Set<string>

  constructor(
    private readonly hook: ProviderRelayItemContinuation,
    private readonly relayId: string,
    private readonly cutThrough: number,
    private readonly replayThrough: number,
    private readonly open: Set<string> | null = null,
    private readonly cutKeys: ReadonlySet<string> | null = null,
    /** Lines through here are saved: a named item's are dropped rather than shown again. */
    private readonly savedThrough = 0
  ) {
    const awaits = (key: string) => key !== RELAY_CUT_KEYS_OVERFLOW && (hook.awaits?.(key) ?? true)
    const resumable = open !== null || hook.mayResume?.() === true
    this.awaited = new Set(resumable ? [...(cutKeys ?? [])].filter(awaits) : [])
  }

  private lastSeq = 0
  /** Lines since a moved item's last one. */
  private sinceMoved = 0
  private pruned = false
  /** Moved items seen only through `follows` lines: maybe whole already, so they hold nothing open. */
  private readonly whole = new Set<string>()

  /**
   * Nothing is left to move: past the replay with no item moved and none named still to come (a
   * cut item paused by a call may resume later; after the overflow key, any may), or once every
   * open work the attach carried has ended (no item outlives it).
   */
  get done(): boolean {
    // The replay itself is read through first: an item may have lines past its work's end.
    if (this.lastSeq < this.replayThrough) {
      return false
    }
    // Once no moved item may resume past the open work, those it awaited for that come no more.
    if (this.awaited.size > 0 && !this.pruned && this.hook.mayResume?.() === false) {
      this.pruned = true
      for (const key of this.awaited) {
        if (!(this.hook.awaits?.(key) ?? true)) {
          this.awaited.delete(key)
        }
      }
    }
    // With no work open, a moved item that stops streaming has ended (it reports no end itself).
    const quiet =
      this.open === null && this.sinceMoved >= MOVED_QUIET_LINES && !this.hook.mayResume?.()
    const settled = (this.moved.size === this.whole.size || quiet) && this.awaited.size === 0
    // Past what a cut names, an unnamed item may resume later, until its open work ends.
    const unnamed = this.open !== null && this.cutKeys?.has(RELAY_CUT_KEYS_OVERFLOW) === true
    const openEnded = this.open !== null && this.open.size === 0 && !this.hook.mayResume?.()
    return (settled && !unnamed) || openEnded
  }

  /** The lines to hand on for this one: itself, re-keyed, or a moved item's finishing lines. */
  lines(seq: number, line: string, floor: ProviderRelayAckFloor | undefined): string[] {
    this.lastSeq = seq
    this.sinceMoved += 1
    if (this.open?.size) {
      const settled = this.hook.settles?.(line)
      if (settled) {
        this.open.delete(settled)
      }
    }
    const item = this.hook.item(line)
    const keys = this.cutKeys
    const named = !keys || keys.has(item?.key ?? '') || keys.has(RELAY_CUT_KEYS_OVERFLOW)
    if (item && keys && named && seq <= this.savedThrough && !this.started.has(item.key)) {
      // Its row holds this line already; the rest of it, if any, continues on its own row.
      return []
    }
    if (item) {
      this.awaited.delete(item.key)
    }
    if (!item || seq <= this.cutThrough) {
      return [line]
    }
    if (item.start) {
      // One item per key at a time: a new start ends whatever was moved under it.
      this.started.add(item.key)
      this.moved.delete(item.key)
      this.whole.delete(item.key)
      return [line]
    }
    let tag = this.moved.get(item.key)
    if (tag === undefined) {
      if (this.started.has(item.key) || !named) {
        return [line]
      }
      tag = `relay:${this.relayId}:${seq}`
      this.moved.set(item.key, tag)
      this.whole.add(item.key)
      floor?.observe(seq, this.hook.start(line, tag))
    }
    this.sinceMoved = 0
    if (!item.follows) {
      this.whole.delete(item.key)
    }
    if (item.end) {
      this.moved.delete(item.key)
      this.whole.delete(item.key)
      this.started.add(item.key)
      return this.hook.finish?.(line, tag) ?? [this.hook.rekey(line, tag)]
    }
    return [this.hook.rekey(line, tag)]
  }
}

/**
 * A reattach whose replay starts inside an open item: the daemon reports where kept lines were
 * given up (at its file cap, or by the client's own ack on its ask), as `truncatedThrough`.
 */
export function attachContinuation(
  hook: ProviderRelayItemContinuation,
  relayId: string,
  fromSeq: number,
  result: ProviderRelayAttachResult
): RelayedProviderContinuation | null {
  const groups = typeof hook.openGroup === 'string' ? [hook.openGroup] : (hook.openGroup ?? [])
  const carried = hook.openAt
    ? hook.openAt(result)
    : groups.flatMap((group) => result.openWork?.[group] ?? []).map((key) => JSON.stringify(key))
  const open = carried?.length ? carried : null
  // Only a replay that may start inside a cut or named item engages it; open work then bounds it.
  if (fromSeq <= 0 || (result.truncatedThrough === undefined && !result.cutKeys?.length)) {
    return null
  }
  return new RelayedProviderContinuation(
    hook,
    relayId,
    result.truncatedThrough ?? fromSeq,
    result.replayThroughSeq,
    open && new Set(open),
    result.cutKeys ? new Set(result.cutKeys) : null,
    result.savedThrough ?? 0
  )
}
