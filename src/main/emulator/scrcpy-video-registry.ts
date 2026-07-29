import type { ScrcpyVideoMeta } from './android/scrcpy-video-frame-parser'

// In-memory pub/sub bridging a live scrcpy session (fed by AndroidEmulatorBackend)
// to renderer subscribers (the video pane, via the emulator-video-stream IPC).
// Caches the codec meta, the config (SPS/PPS) frame, and the current GOP
// (keyframe + following deltas) so a late subscriber can initialize its WebCodecs
// decoder and decode from the keyframe immediately, not after the next GOP.

// scrcpy keyframes ~every 10s; high-motion content can otherwise buffer
// hundreds of deltas. Cap the replayed GOP so memory stays bounded and a
// late subscriber isn't flooded — always keep the keyframe at index 0.
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

export type ScrcpyVideoSubscriber = (event: ScrcpyVideoEvent) => void

type RegistryEntry = {
  meta?: ScrcpyVideoMeta
  config?: ScrcpyVideoFrameMessage
  gop: ScrcpyVideoFrameMessage[]
  subscribers: Set<ScrcpyVideoSubscriber>
  close: () => void
}

class ScrcpyVideoRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  register(deviceId: string, close: () => void): void {
    this.entries.set(deviceId, { subscribers: new Set(), gop: [], close })
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
      // A keyframe starts a fresh decodeable GOP; buffer it + the following
      // deltas so a late subscriber can decode immediately on replay.
      entry.gop = [frame]
    } else if (entry.gop.length > 0) {
      // Only buffer deltas once a keyframe anchors the GOP (a delta alone is
      // undecodable); deltas before the first keyframe are still sent live below.
      entry.gop.push(frame)
      // Drop the oldest delta (never index 0, the keyframe) so replay stays decodable.
      if (entry.gop.length > MAX_GOP_FRAMES) {
        entry.gop.splice(1, 1)
      }
    }
    for (const subscriber of entry.subscribers) {
      subscriber({ type: 'frame', frame })
    }
  }

  // Subscribe a renderer; replays the cached meta + config so the decoder can
  // start without waiting for the next keyframe. Returns an unsubscribe fn.
  subscribe(deviceId: string, subscriber: ScrcpyVideoSubscriber): () => void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return () => {}
    }
    if (entry.meta) {
      subscriber({ type: 'meta', meta: entry.meta })
    }
    if (entry.config) {
      subscriber({ type: 'frame', frame: entry.config })
    }
    // Replay the current GOP (keyframe + deltas) so the decoder starts now.
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
    entry.close()
    entry.subscribers.clear()
    this.entries.delete(deviceId)
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId)
  }
}

export const scrcpyVideoRegistry = new ScrcpyVideoRegistry()
