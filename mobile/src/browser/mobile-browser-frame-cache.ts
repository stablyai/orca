import { Buffer } from 'buffer'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'

export const MOBILE_BROWSER_FRAME_MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MOBILE_BROWSER_FRAME_CACHE_MAX_ENTRIES = 4
export const MOBILE_BROWSER_FRAME_CACHE_MAX_RETAINED_CHARACTERS = 16 * 1024 * 1024

export type MobileBrowserFrameCacheEntry = {
  uri: string
  metadata: BrowserScreencastFrameMetadata
}

export type MobileBrowserFrameCacheEvidence = {
  entryCount: number
  retainedCharacters: number
  keysOldestFirst: string[]
}

type RetainedFrame = {
  entry: MobileBrowserFrameCacheEntry
  retainedCharacters: number
}

export class MobileBrowserFrameCache {
  private readonly entries = new Map<string, RetainedFrame>()
  private retainedCharacters = 0

  constructor(
    private readonly maxEntries = MOBILE_BROWSER_FRAME_CACHE_MAX_ENTRIES,
    private readonly maxRetainedCharacters = MOBILE_BROWSER_FRAME_CACHE_MAX_RETAINED_CHARACTERS
  ) {
    if (
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxRetainedCharacters) ||
      maxRetainedCharacters < 1
    ) {
      throw new Error('Mobile browser frame cache limits must be positive integers')
    }
  }

  get(key: string | null): MobileBrowserFrameCacheEntry | null {
    if (!key) {
      return null
    }
    const retained = this.entries.get(key)
    if (!retained) {
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, retained)
    return retained.entry
  }

  peek(key: string | null): MobileBrowserFrameCacheEntry | null {
    return key ? (this.entries.get(key)?.entry ?? null) : null
  }

  set(key: string | null, entry: MobileBrowserFrameCacheEntry): boolean {
    if (!key) {
      return false
    }
    const retainedCharacters = key.length + entry.uri.length
    const previous = this.entries.get(key)
    if (previous) {
      this.retainedCharacters -= previous.retainedCharacters
      this.entries.delete(key)
    }
    if (retainedCharacters > this.maxRetainedCharacters) {
      return false
    }
    this.entries.set(key, { entry, retainedCharacters })
    this.retainedCharacters += retainedCharacters
    this.evictOverflow()
    return this.entries.has(key)
  }

  clearWorktree(worktreeId: string): void {
    const prefix = `${worktreeId}:`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key)
      }
    }
  }

  clear(): void {
    this.entries.clear()
    this.retainedCharacters = 0
  }

  evidence(): MobileBrowserFrameCacheEvidence {
    return {
      entryCount: this.entries.size,
      retainedCharacters: this.retainedCharacters,
      keysOldestFirst: [...this.entries.keys()]
    }
  }

  private delete(key: string): void {
    const retained = this.entries.get(key)
    if (!retained) {
      return
    }
    this.retainedCharacters -= retained.retainedCharacters
    this.entries.delete(key)
  }

  private evictOverflow(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.retainedCharacters > this.maxRetainedCharacters
    ) {
      const oldestKey = this.entries.keys().next().value
      if (typeof oldestKey !== 'string') {
        return
      }
      this.delete(oldestKey)
    }
  }
}

export function createMobileBrowserFrameDataUri(
  frame: BrowserScreencastFrame,
  maxImageBytes = MOBILE_BROWSER_FRAME_MAX_IMAGE_BYTES
): string | null {
  if (frame.image.byteLength > maxImageBytes) {
    return null
  }
  return `data:image/${frame.format};base64,${Buffer.from(frame.image).toString('base64')}`
}
