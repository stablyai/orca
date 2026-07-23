import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const MAX_RUNTIME_OPERATION_GENERATIONS = 8_192
export const MAX_RUNTIME_OPERATION_GENERATION_KEY_BYTES = 64 * 1024
export const MAX_RUNTIME_OPERATION_GENERATION_RETAINED_KEY_BYTES = 4 * 1024 * 1024

export type RuntimeOperationGenerationBounds = {
  maxEntries: number
  maxKeyBytes: number
  maxRetainedKeyBytes: number
}

const DEFAULT_BOUNDS: RuntimeOperationGenerationBounds = {
  maxEntries: MAX_RUNTIME_OPERATION_GENERATIONS,
  maxKeyBytes: MAX_RUNTIME_OPERATION_GENERATION_KEY_BYTES,
  maxRetainedKeyBytes: MAX_RUNTIME_OPERATION_GENERATION_RETAINED_KEY_BYTES
}

type RetainedGeneration = {
  generation: number
  keyBytes: number
}

export class RuntimeOperationGenerations {
  private readonly generations = new Map<string, RetainedGeneration>()
  private nextGeneration = 1
  private retainedKeyBytes = 0

  constructor(private readonly bounds: RuntimeOperationGenerationBounds = DEFAULT_BOUNDS) {
    if (
      !Number.isSafeInteger(bounds.maxEntries) ||
      bounds.maxEntries < 1 ||
      !Number.isSafeInteger(bounds.maxKeyBytes) ||
      bounds.maxKeyBytes < 1 ||
      !Number.isSafeInteger(bounds.maxRetainedKeyBytes) ||
      bounds.maxRetainedKeyBytes < 1
    ) {
      throw new RangeError('Runtime operation generation bounds must be positive integers')
    }
  }

  current(key: string): number {
    const retained = this.generations.get(key)
    if (!retained) {
      // Why: a missing key may have been evicted, so it must never reuse a stale token.
      return this.replace(key)
    }
    this.generations.delete(key)
    this.generations.set(key, retained)
    return retained.generation
  }

  advance(key: string): number {
    return this.replace(key)
  }

  isCurrent(key: string, generation: number): boolean {
    const retained = this.generations.get(key)
    if (retained?.generation !== generation) {
      return false
    }
    this.generations.delete(key)
    this.generations.set(key, retained)
    return true
  }

  forget(key: string): void {
    this.delete(key)
  }

  evidence(): { entries: number; retainedKeyBytes: number } {
    return {
      entries: this.generations.size,
      retainedKeyBytes: this.retainedKeyBytes
    }
  }

  private replace(key: string): number {
    this.delete(key)
    const generation = this.takeGeneration()
    const measurement = measureUtf8ByteLength(key, {
      stopAfterBytes: this.bounds.maxKeyBytes
    })
    if (measurement.exceededLimit || measurement.byteLength > this.bounds.maxRetainedKeyBytes) {
      return generation
    }
    while (
      this.generations.size >= this.bounds.maxEntries ||
      this.retainedKeyBytes + measurement.byteLength > this.bounds.maxRetainedKeyBytes
    ) {
      const oldest = this.generations.keys().next().value
      if (oldest === undefined) {
        return generation
      }
      this.delete(oldest)
    }
    this.generations.set(key, {
      generation,
      keyBytes: measurement.byteLength
    })
    this.retainedKeyBytes += measurement.byteLength
    return generation
  }

  private takeGeneration(): number {
    if (!Number.isSafeInteger(this.nextGeneration)) {
      throw new Error('Runtime operation generation exhausted')
    }
    const generation = this.nextGeneration
    this.nextGeneration += 1
    return generation
  }

  private delete(key: string): void {
    const retained = this.generations.get(key)
    if (!retained) {
      return
    }
    this.generations.delete(key)
    this.retainedKeyBytes -= retained.keyBytes
  }
}
