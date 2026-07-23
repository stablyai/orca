import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export type CodexWslReconciliationGenerationBounds = {
  maxEntries: number
  maxKeyBytes: number
  maxTotalKeyBytes: number
}

export const DEFAULT_CODEX_WSL_RECONCILIATION_GENERATION_BOUNDS: CodexWslReconciliationGenerationBounds =
  {
    maxEntries: 256,
    maxKeyBytes: 64 * 1024,
    maxTotalKeyBytes: 1024 * 1024
  }

type RetainedGeneration = {
  generation: number
  keyBytes: number
}

export class CodexWslReconciliationGenerations {
  private readonly generations = new Map<string, RetainedGeneration>()
  private nextGeneration = 0
  private retainedKeyBytes = 0

  constructor(
    private readonly bounds: CodexWslReconciliationGenerationBounds = DEFAULT_CODEX_WSL_RECONCILIATION_GENERATION_BOUNDS
  ) {
    for (const value of Object.values(bounds)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('Codex WSL reconciliation bounds must be positive integers')
      }
    }
  }

  advance(key: string): number {
    const generation = ++this.nextGeneration
    const keyBytes = measureUtf8ByteLength(key, {
      stopAfterBytes: this.bounds.maxKeyBytes
    })
    this.delete(key)
    if (keyBytes.exceededLimit || keyBytes.byteLength > this.bounds.maxTotalKeyBytes) {
      return generation
    }
    while (
      this.generations.size >= this.bounds.maxEntries ||
      this.retainedKeyBytes + keyBytes.byteLength > this.bounds.maxTotalKeyBytes
    ) {
      const oldest = this.generations.keys().next().value
      if (oldest === undefined) {
        return generation
      }
      this.delete(oldest)
    }
    this.generations.set(key, { generation, keyBytes: keyBytes.byteLength })
    this.retainedKeyBytes += keyBytes.byteLength
    return generation
  }

  isCurrent(key: string, generation: number): boolean {
    return this.generations.get(key)?.generation === generation
  }

  evidence(): { entries: number; keyBytes: number } {
    return { entries: this.generations.size, keyBytes: this.retainedKeyBytes }
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
