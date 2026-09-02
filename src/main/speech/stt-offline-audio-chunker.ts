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
  private buffered: Float32Array[] = []
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
    this.buffered.push(samples)
    this.bufferedSamples += samples.length

    const ready: Float32Array[] = []
    while (this.bufferedSamples >= this.chunkSampleLimit) {
      const combined = this.combineBuffered()
      const splitIndex = this.findQuietSplitIndex(combined)
      ready.push(combined.slice(0, splitIndex))
      const tail = combined.slice(splitIndex)
      this.buffered = tail.length > 0 ? [tail] : []
      this.bufferedSamples = tail.length
    }
    return ready
  }

  /** Returns all remaining buffered audio (any length below the chunk limit). */
  flush(): Float32Array | null {
    if (this.bufferedSamples === 0) {
      return null
    }
    const combined = this.combineBuffered()
    this.buffered = []
    this.bufferedSamples = 0
    return combined
  }

  private combineBuffered(): Float32Array {
    if (this.buffered.length === 1) {
      return this.buffered[0]
    }
    const combined = new Float32Array(this.bufferedSamples)
    let offset = 0
    for (const chunk of this.buffered) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    return combined
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
