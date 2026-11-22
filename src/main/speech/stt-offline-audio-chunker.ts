// Parakeet has no long-form mode, and bounded chunks keep the decode left for stop short.
export const OFFLINE_DECODE_CHUNK_SECONDS = 30

// Split near quiet tail pauses to avoid mid-word cuts; ~100ms windows exclude short intra-word closures.
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

  /** Samples pushed but not yet returned. */
  get heldSamples(): number {
    return this.bufferedSamples
  }

  /** Return complete bounded chunks as samples arrive. */
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

  /** Return the remaining audio, below the chunk limit. */
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
    // Consume at least one sample or push() loops forever.
    return Math.max(1, bestIndex)
  }
}

// Without the detector, audio is still cut at the decode bound, just not at pauses.
export type AudioSegmenter = {
  readonly heldSamples: number
  readonly phraseOpen?: boolean
  push(samples: Float32Array): Float32Array[] | Promise<Float32Array[]>
  flush(): Float32Array[] | Promise<Float32Array[]>
}

export function boundedChunks(sampleRate: number): AudioSegmenter {
  const chunker = new OfflineAudioChunker(sampleRate)
  return {
    get heldSamples() {
      return chunker.heldSamples
    },
    push: (samples) => chunker.push(samples),
    flush: () => {
      const rest = chunker.flush()
      return rest ? [rest] : []
    }
  }
}

export function joinAudio(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) {
    return parts[0]
  }
  const joined = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
