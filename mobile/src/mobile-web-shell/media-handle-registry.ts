import { BridgeNativeVerbRefusedError } from './bridge-host-errors'
import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  BRIDGE_MEDIA_READ_MAX_BYTES,
  type BridgeMediaItem
} from './bridge/bridge-media-verbs'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../src/shared/clipboard-image'

// Expire abandoned picks after five idle minutes; refresh on touch so chunked reads cannot lose their file mid-transfer.
export const MEDIA_HANDLE_TTL_MS = 5 * 60 * 1000

export type StagedMedia = {
  // The shell owns this cache copy and deletes it on release.
  readonly uri: string
  readonly mime: string
  readonly byteLength: number
  readonly width?: number
  readonly height?: number
  // Expose picker names through native.media.name only, never on minted items.
  readonly name?: string
}

export type MediaChunkRange = {
  readonly uri: string
  readonly start: number
  readonly end: number
  readonly eof: boolean
}

export type MediaHandleRegistryDeps = {
  readonly now: () => number
  readonly discard: (uri: string) => void
}

type LiveHandle = StagedMedia & { touchedAt: number }

// Own staged files per page session: explicit release, idle expiry and idempotent session/unmount cleanup cover documents that disappear without releasing.
export class MediaHandleRegistry {
  private readonly live = new Map<string, LiveHandle>()
  private minted = 0
  private releaseGeneration = 0

  constructor(private readonly deps: MediaHandleRegistryDeps) {}

  get generation(): number {
    return this.releaseGeneration
  }

  liveCount(): number {
    this.sweep()
    return this.live.size
  }

  remainingCapacity(): number {
    return BRIDGE_MEDIA_MAX_LIVE_HANDLES - this.liveCount()
  }

  // Refuse and discard the whole pick at capacity; truncating a multi-select would silently impersonate a smaller user selection.
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

  // Refuse reads past a nonempty file’s eof to expose lost cursors instead of allowing empty-read loops; empty files still get one read.
  read(handle: string, offset: number, length: number): MediaChunkRange {
    const record = this.hold(handle)
    if (record.byteLength > 0 && offset >= record.byteLength) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_range',
        `that handle holds ${record.byteLength} bytes and the read starts at ${offset}`
      )
    }
    record.touchedAt = this.deps.now()
    // Enforce the chunk ceiling even for direct callers that bypass the wire schema.
    const end = Math.min(offset + Math.min(length, BRIDGE_MEDIA_READ_MAX_BYTES), record.byteLength)
    return { uri: record.uri, start: offset, end, eof: end >= record.byteLength }
  }

  name(handle: string): string | null {
    const record = this.hold(handle)
    record.touchedAt = this.deps.now()
    return record.name ?? null
  }

  // Sweep before lookup so expired handles report false too; repeated release is normal teardown, not a fault.
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

  releaseAll(): void {
    this.releaseGeneration += 1
    for (const [handle, record] of this.live) {
      this.live.delete(handle)
      this.discard(record.uri)
    }
  }

  private hold(handle: string): LiveHandle {
    this.sweep()
    const record = this.live.get(handle)
    if (record === undefined) {
      // Use one unknown-handle response for absent/released/expired handles so session history does not become an oracle.
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

  // Best effort: an already-reclaimed file must not strand remaining handles.
  private discard(uri: string): void {
    try {
      this.deps.discard(uri)
    } catch (error) {
      console.warn('[web-shell-bridge] a staged media file could not be deleted', { uri }, error)
    }
  }
}

// Keep handler staging and registry limits on the same source-byte ceiling.
export const MEDIA_STAGED_MAX_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
