import type { ScrcpyVideoMeta } from './android/scrcpy-video-frame-parser'

// In-memory pub/sub bridging a live scrcpy session (fed by AndroidEmulatorBackend)
// to renderer subscribers (the video pane, via the emulator-video-stream IPC).
// Caches the codec meta, the config (SPS/PPS) frame, and the current GOP
// (keyframe + following deltas) so a late subscriber can initialize its WebCodecs
// decoder and decode from the keyframe immediately, not after the next GOP.

// scrcpy keyframes ~every 10s; high-motion content can otherwise buffer
// hundreds of deltas. Cap the replayed GOP so memory stays bounded and a
// late subscriber isn't flooded. An overloaded GOP is shed as a unit because
// dropping an interior delta would make the retained suffix undecodable.
export const SCRCPY_VIDEO_MAX_GOP_FRAMES = 120
export const SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE = 32 * 1024 * 1024
export const SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL = 128 * 1024 * 1024
export const SCRCPY_VIDEO_MAX_REGISTRY_ENTRIES = 16
export const SCRCPY_VIDEO_MAX_SUBSCRIBERS = 8

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
  retainedBytes: number
}

class ScrcpyVideoRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private retainedBytes = 0
  private subscriberCount = 0

  register(deviceId: string, close: () => void): void {
    if (!this.entries.has(deviceId) && this.entries.size >= SCRCPY_VIDEO_MAX_REGISTRY_ENTRIES) {
      throw new Error(
        `Orca can have at most ${SCRCPY_VIDEO_MAX_REGISTRY_ENTRIES} active scrcpy video streams.`
      )
    }
    this.stop(deviceId)
    this.entries.set(deviceId, {
      subscribers: new Set(),
      gop: [],
      close,
      retainedBytes: 0
    })
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
      this.replaceConfig(entry, frame)
    } else if (frame.keyFrame) {
      // A keyframe starts a fresh decodeable GOP; buffer it + the following
      // deltas so a late subscriber can decode immediately on replay.
      this.clearGop(entry)
      entry.gop.push(frame)
      this.adjustRetainedBytes(entry, frame.bytes.byteLength)
    } else if (entry.gop.length > 0) {
      // Only buffer deltas once a keyframe anchors the GOP (a delta alone is
      // undecodable); deltas before the first keyframe are still sent live below.
      entry.gop.push(frame)
      this.adjustRetainedBytes(entry, frame.bytes.byteLength)
    }
    this.trimEntryReplay(entry)
    this.trimAggregateReplay(deviceId)
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
    if (this.subscriberCount >= SCRCPY_VIDEO_MAX_SUBSCRIBERS) {
      throw new Error(
        `Orca can have at most ${SCRCPY_VIDEO_MAX_SUBSCRIBERS} scrcpy video subscribers.`
      )
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
    if (this.entries.get(deviceId) !== entry) {
      return () => {}
    }
    entry.subscribers.add(subscriber)
    this.subscriberCount += 1
    return () => {
      if (entry.subscribers.delete(subscriber)) {
        this.subscriberCount -= 1
      }
    }
  }

  stop(deviceId: string): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    this.entries.delete(deviceId)
    this.subscriberCount -= entry.subscribers.size
    entry.subscribers.clear()
    this.clearGop(entry)
    this.clearConfig(entry)
    entry.close()
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId)
  }

  private adjustRetainedBytes(entry: RegistryEntry, delta: number): void {
    entry.retainedBytes += delta
    this.retainedBytes += delta
  }

  private replaceConfig(entry: RegistryEntry, frame: ScrcpyVideoFrameMessage): void {
    this.clearConfig(entry)
    entry.config = frame
    this.adjustRetainedBytes(entry, frame.bytes.byteLength)
  }

  private clearConfig(entry: RegistryEntry): void {
    if (!entry.config) {
      return
    }
    this.adjustRetainedBytes(entry, -entry.config.bytes.byteLength)
    entry.config = undefined
  }

  private clearGop(entry: RegistryEntry): void {
    for (const frame of entry.gop) {
      this.adjustRetainedBytes(entry, -frame.bytes.byteLength)
    }
    entry.gop = []
  }

  private trimEntryReplay(entry: RegistryEntry): void {
    if (
      entry.gop.length > SCRCPY_VIDEO_MAX_GOP_FRAMES ||
      entry.retainedBytes > SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE
    ) {
      this.clearGop(entry)
    }
    if (entry.retainedBytes > SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE) {
      this.clearConfig(entry)
    }
  }

  private trimAggregateReplay(preferredDeviceId: string): void {
    if (this.retainedBytes <= SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL) {
      return
    }
    const preferred = this.entries.get(preferredDeviceId)

    for (const [deviceId, entry] of this.entries) {
      if (deviceId === preferredDeviceId) {
        continue
      }
      if (this.retainedBytes > SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL && entry.gop.length > 0) {
        this.clearGop(entry)
      }
    }
    if (
      preferred &&
      this.retainedBytes > SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL &&
      preferred.gop.length > 0
    ) {
      this.clearGop(preferred)
    }
    for (const [deviceId, entry] of this.entries) {
      if (this.retainedBytes <= SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL) {
        break
      }
      if (deviceId === preferredDeviceId) {
        continue
      }
      this.clearConfig(entry)
    }
    if (preferred && this.retainedBytes > SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL) {
      this.clearConfig(preferred)
    }
  }
}

export const scrcpyVideoRegistry = new ScrcpyVideoRegistry()
