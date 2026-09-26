import { BridgeNativeVerbRefusedError } from './bridge-host-errors'
import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  BRIDGE_MEDIA_READ_MAX_BYTES,
  type BridgeMediaItem
} from './bridge/bridge-media-verbs'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../src/shared/clipboard-image'

/**
 * How long a staged file survives with nothing reading it.
 *
 * The read itself is nowhere near this. The largest item a pick may stage is
 * `CLIPBOARD_IMAGE_MAX_SOURCE_BYTES`, which at `BRIDGE_MEDIA_READ_MAX_BYTES` a chunk is
 * 48 round trips over a `postMessage` that measures in fractions of a millisecond. The TTL is not
 * sized for that: it is sized for the page that picked and then stopped — the user who backgrounded
 * the app mid-composer, the document that faulted before its first chunk — where nothing will ever
 * call `release` and the only other sweep is the session's own end. Five minutes is three orders of
 * magnitude above the read and short enough that an abandoned pick does not outlive the screen it
 * was made on.
 *
 * Measured from the last touch, not from the mint: a page reading a large file one chunk at a time
 * must not have the file swept out from under it halfway through.
 */
export const MEDIA_HANDLE_TTL_MS = 5 * 60 * 1000

/** What a picker handed back, before a handle names it. */
export type StagedMedia = {
  /** The shell's own copy, in the cache directory. Deleting it is what `release` does. */
  readonly uri: string
  readonly mime: string
  readonly byteLength: number
  readonly width?: number
  readonly height?: number
}

/** The byte range one `read` covers, and whether it is the last. */
export type MediaChunkRange = {
  readonly uri: string
  readonly start: number
  readonly end: number
  readonly eof: boolean
}

export type MediaHandleRegistryDeps = {
  readonly now: () => number
  /** Deletes one staged file. Throwing is how a device says it could not. */
  readonly discard: (uri: string) => void
}

type LiveHandle = StagedMedia & { touchedAt: number }

/**
 * The staged files one page session holds, and every way one of them ends.
 *
 * A handle is a name for a file this shell copied into its own cache, and the whole reason the
 * registry exists is that such a file has no owner otherwise: the page that asked for it is a
 * document that can navigate, fault or be swiped away without telling anyone. So the lifetime is
 * bounded four ways, and all four are here — the page's own `release`, the TTL above, and
 * `releaseAll`, which the session's end and the page's unmount both call.
 *
 * Pure bookkeeping on purpose. Picking and reading are the device's, so they live on the platform
 * handler; what is left is the part worth testing without a simulator.
 */
export class MediaHandleRegistry {
  private readonly live = new Map<string, LiveHandle>()
  private minted = 0

  constructor(private readonly deps: MediaHandleRegistryDeps) {}

  liveCount(): number {
    this.sweep()
    return this.live.size
  }

  /** How many more items this session may hold. What a picker should be allowed to return. */
  remainingCapacity(): number {
    return BRIDGE_MEDIA_MAX_LIVE_HANDLES - this.liveCount()
  }

  /**
   * Names each staged file, or refuses the pick whole and discards what it staged.
   *
   * Whole rather than truncated: half a multi-select is an answer the page cannot tell from a user
   * who picked fewer, and the files it would drop are already on disk. Refusing leaves the page one
   * thing to do, which is release what it is still holding.
   */
  mint(staged: readonly StagedMedia[]): BridgeMediaItem[] {
    this.sweep()
    if (this.live.size + staged.length > BRIDGE_MEDIA_MAX_LIVE_HANDLES) {
      for (const item of staged) {
        this.discard(item.uri)
      }
      throw new BridgeNativeVerbRefusedError(
        'native_media_handle_cap',
        `this page already holds ${this.live.size} of ${BRIDGE_MEDIA_MAX_LIVE_HANDLES} staged items`
      )
    }
    return staged.map((item) => {
      this.minted += 1
      const handle = `media-${this.minted}-${this.deps.now().toString(36)}`
      this.live.set(handle, { ...item, touchedAt: this.deps.now() })
      return {
        handle,
        mime: item.mime,
        byteLength: item.byteLength,
        ...(item.width === undefined ? {} : { width: item.width }),
        ...(item.height === undefined ? {} : { height: item.height })
      }
    })
  }

  /**
   * The range a chunk covers, or the refusal the page gets instead.
   *
   * A read at or past the end of a file that had bytes is refused rather than answered empty: the
   * previous chunk already said `eof`, so a page asking again has lost track of its own cursor, and
   * an empty answer would let it loop forever instead of failing where the bug is. An empty staged
   * file is read once, because there is no earlier chunk to have said it.
   */
  read(handle: string, offset: number, length: number): MediaChunkRange {
    const record = this.hold(handle)
    if (record.byteLength > 0 && offset >= record.byteLength) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_range',
        `that handle holds ${record.byteLength} bytes and the read starts at ${offset}`
      )
    }
    record.touchedAt = this.deps.now()
    // The chunk cap is applied here as well as at the wire, because the two bounds are different
    // promises: `mediaReadParamsSchema` says what a page may ask for, and this says what the
    // registry will ever hand a reader, whoever asked. Its own test calls `read` directly, which
    // is the caller that reaches it.
    const end = Math.min(offset + Math.min(length, BRIDGE_MEDIA_READ_MAX_BYTES), record.byteLength)
    return { uri: record.uri, start: offset, end, eof: end >= record.byteLength }
  }

  /**
   * False for a handle this session no longer holds: releasing twice is not a fault.
   *
   * Swept first, like every other path that reads the map. Without it this was the one lifetime
   * path that could still see an expired handle, so a page releasing after the TTL was told
   * `released: true` for a file the next sweep would have taken anyway — the opposite of what
   * `mediaReleaseParamsSchema` promises the page.
   */
  release(handle: string): boolean {
    this.sweep()
    const record = this.live.get(handle)
    if (record === undefined) {
      return false
    }
    this.live.delete(handle)
    this.discard(record.uri)
    return true
  }

  /** The session ended or the page unmounted. Both reach this, and it runs twice without harm. */
  releaseAll(): void {
    for (const [handle, record] of this.live) {
      this.live.delete(handle)
      this.discard(record.uri)
    }
  }

  private hold(handle: string): LiveHandle {
    this.sweep()
    const record = this.live.get(handle)
    if (record === undefined) {
      // One answer for never-minted, released and swept alike: which of the three it was is a fact
      // about this session's history, and a page that lost its handle acts the same way on all of
      // them. Telling them apart would be an oracle for a handle somebody else picked.
      throw new BridgeNativeVerbRefusedError(
        'native_media_handle_unknown',
        'this session holds no staged item under that handle'
      )
    }
    return record
  }

  private sweep(): void {
    const cutoff = this.deps.now() - MEDIA_HANDLE_TTL_MS
    for (const [handle, record] of this.live) {
      if (record.touchedAt <= cutoff) {
        this.live.delete(handle)
        this.discard(record.uri)
      }
    }
  }

  /** Best effort: a file the OS reclaimed first must not strand the handles behind it. */
  private discard(uri: string): void {
    try {
      this.deps.discard(uri)
    } catch (error) {
      console.warn('[web-shell-bridge] a staged media file could not be deleted', { uri }, error)
    }
  }
}

/** The ceiling the registry's own bounds are read against, re-exported for the handler that
 *  stages files so the two cannot disagree about what a picked item may weigh. */
export const MEDIA_STAGED_MAX_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
