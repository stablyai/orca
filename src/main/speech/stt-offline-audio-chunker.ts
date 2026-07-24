// Why: offline recognizers decode a whole buffer per call, and ONNX Runtime's
// arena allocations scale with buffer length. Chromium's allocator shim kills
// the entire app on any single allocation >= 2 GiB (#7925), so audio must be
// decoded in bounded chunks regardless of how long dictation runs.
export const OFFLINE_DECODE_CHUNK_SECONDS = 30

// Why: cutting audio mid-word degrades transcription at chunk boundaries.
// Search the tail of each chunk for its quietest window and split at its
// center, so cuts land on real inter-word pauses whenever one exists. The
// window must be pause-sized (~100ms): shorter windows match momentary
// quiet inside a word (e.g. plosive closures) and cut mid-word.
const SPLIT_SEARCH_SECONDS = 5
const SPLIT_ENERGY_WINDOW_SECONDS = 0.1

export class OfflineAudioChunker {
  private buffered = new Float32Array(0)
  private bufferedSamples = 0
  private readonly chunkSampleLimit: number
  private readonly splitSearchSamples: number
  private readonly energyWindowSamples: number

  constructor(sampleRate: number) {
    this.chunkSampleLimit = Math.max(1, Math.round(OFFLINE_DECODE_CHUNK_SECONDS * sampleRate))
    this.splitSearchSamples = Math.round(SPLIT_SEARCH_SECONDS * sampleRate)
    this.energyWindowSamples = Math.max(1, Math.round(SPLIT_ENERGY_WINDOW_SECONDS * sampleRate))
  }

  /** Buffers samples and returns any full chunks now ready to decode. */
  push(samples: Float32Array): Float32Array[] {
    if (samples.length === 0) {
      return []
    }
    this.append(samples)

    const ready: Float32Array[] = []
    while (this.bufferedSamples >= this.chunkSampleLimit) {
      const splitIndex = this.findQuietSplitIndex(this.buffered.subarray(0, this.bufferedSamples))
      ready.push(this.buffered.slice(0, splitIndex))
      this.buffered.copyWithin(0, splitIndex, this.bufferedSamples)
      this.bufferedSamples -= splitIndex
    }
    this.releaseOversizedCapacity()
    return ready
  }

  /** Returns all remaining buffered audio (any length below the chunk limit). */
  flush(): Float32Array | null {
    if (this.bufferedSamples === 0) {
      return null
    }
    const combined = this.buffered.slice(0, this.bufferedSamples)
    this.buffered = new Float32Array(0)
    this.bufferedSamples = 0
    return combined
  }

  private append(samples: Float32Array): void {
    const required = this.bufferedSamples + samples.length
    if (required > this.buffered.length) {
      const capacity = Math.max(required, Math.max(1_024, this.buffered.length * 2))
      const next = new Float32Array(capacity)
      next.set(this.buffered.subarray(0, this.bufferedSamples))
      this.buffered = next
    }
    this.buffered.set(samples, this.bufferedSamples)
    this.bufferedSamples = required
  }

  private releaseOversizedCapacity(): void {
    const retainedCapacity = Math.max(this.chunkSampleLimit, this.bufferedSamples)
    if (this.buffered.length <= retainedCapacity * 2) {
      return
    }
    const compacted = new Float32Array(retainedCapacity)
    compacted.set(this.buffered.subarray(0, this.bufferedSamples))
    this.buffered = compacted
  }

  private findQuietSplitIndex(samples: Float32Array): number {
    const limit = Math.min(this.chunkSampleLimit, samples.length)
    const window = this.energyWindowSamples
    const searchStart = Math.max(0, limit - this.splitSearchSamples)
    const hop = Math.max(1, Math.floor(window / 2))
    let bestIndex = limit
    let bestEnergy = Infinity
    for (let start = searchStart; start + window <= limit; start += hop) {
      let energy = 0
      for (let i = start; i < start + window; i += 1) {
        energy += samples[i] * samples[i]
      }
      if (energy < bestEnergy) {
        bestEnergy = energy
        bestIndex = start + Math.floor(window / 2)
      }
    }
    // Why: the split must consume at least one sample or push() would loop forever.
    return Math.max(1, bestIndex)
  }
}
