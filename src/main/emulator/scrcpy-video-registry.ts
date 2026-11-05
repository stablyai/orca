import type { ScrcpyVideoMeta } from './android/scrcpy-video-frame-parser'
import type { ScrcpyControlTarget } from './android/scrcpy-stream-session'

// Cache metadata, decoder config, and the current GOP for late subscribers. The entry also
// holds the session's control channel so input reaches the server that produces the video.

// Bound high-motion replay caches while retaining their leading keyframe.
const MAX_GOP_FRAMES = 120

export type ScrcpyVideoFrameMessage = {
  config: boolean
  keyFrame: boolean
  pts: string
  bytes: ArrayBuffer
}

export type ScrcpyVideoEvent =
  | { type: 'meta'; meta: ScrcpyVideoMeta }
  | { type: 'frame'; frame: ScrcpyVideoFrameMessage }
  // The scrcpy session is gone; subscribers must restart it rather than wait for frames.
  | { type: 'end' }

export type ScrcpyVideoSubscriber = (event: ScrcpyVideoEvent) => void

type RegistryEntry = {
  meta?: ScrcpyVideoMeta
  config?: ScrcpyVideoFrameMessage
  gop: ScrcpyVideoFrameMessage[]
  subscribers: Set<ScrcpyVideoSubscriber>
  close: () => void
  control?: ScrcpyControlTarget
}

class ScrcpyVideoRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  register(deviceId: string, close: () => void): void {
    this.entries.set(deviceId, { subscribers: new Set(), gop: [], close })
  }

  attachControl(deviceId: string, control: ScrcpyControlTarget): void {
    const entry = this.entries.get(deviceId)
    if (entry) {
      entry.control = control
    }
  }

  control(deviceId: string): ScrcpyControlTarget | null {
    return this.entries.get(deviceId)?.control ?? null
  }

  pushMeta(deviceId: string, meta: ScrcpyVideoMeta): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    entry.meta = meta
    for (const subscriber of entry.subscribers) {
      subscriber({ type: 'meta', meta })
    }
  }

  pushFrame(deviceId: string, frame: ScrcpyVideoFrameMessage): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    if (frame.config) {
      entry.config = frame
    } else if (frame.keyFrame) {
      entry.gop = [frame]
    } else if (entry.gop.length > 0) {
      // Cache deltas only after a keyframe; pre-keyframe deltas are still delivered live.
      entry.gop.push(frame)
      // Preserve the leading keyframe when bounding the cache.
      if (entry.gop.length > MAX_GOP_FRAMES) {
        entry.gop.splice(1, 1)
      }
    }
    for (const subscriber of entry.subscribers) {
      subscriber({ type: 'frame', frame })
    }
  }

  subscribe(deviceId: string, subscriber: ScrcpyVideoSubscriber): () => void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      subscriber({ type: 'end' })
      return () => {}
    }
    if (entry.meta) {
      subscriber({ type: 'meta', meta: entry.meta })
    }
    if (entry.config) {
      subscriber({ type: 'frame', frame: entry.config })
    }
    for (const frame of entry.gop) {
      subscriber({ type: 'frame', frame })
    }
    entry.subscribers.add(subscriber)
    return () => entry.subscribers.delete(subscriber)
  }

  stop(deviceId: string): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    this.entries.delete(deviceId)
    entry.close()
    for (const subscriber of entry.subscribers) {
      subscriber({ type: 'end' })
    }
    entry.subscribers.clear()
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId)
  }
}

export const scrcpyVideoRegistry = new ScrcpyVideoRegistry()
