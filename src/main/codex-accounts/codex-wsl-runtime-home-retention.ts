import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export type CodexWslRuntimeHomeRetentionBounds = {
  maxEntries: number
  maxKeyBytes: number
  maxValueBytes: number
  maxTotalBytes: number
}

export const DEFAULT_CODEX_WSL_RUNTIME_HOME_RETENTION_BOUNDS: CodexWslRuntimeHomeRetentionBounds = {
  maxEntries: 64,
  maxKeyBytes: 1024,
  maxValueBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
}

type CodexWslRuntimeHomeEntry = {
  runtimeHomePath?: string
  lastWrittenAuthJson?: string | null
  lastSyncedAccountId?: string | null
  retainedBytes: number
}

export class CodexWslRuntimeHomeRetention {
  private readonly entries = new Map<string, CodexWslRuntimeHomeEntry>()
  private retainedBytes = 0

  constructor(
    private readonly bounds: CodexWslRuntimeHomeRetentionBounds = DEFAULT_CODEX_WSL_RUNTIME_HOME_RETENTION_BOUNDS
  ) {
    for (const value of Object.values(bounds)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('Codex WSL runtime-home retention bounds must be positive integers')
      }
    }
  }

  getRuntimeHomePath(distro: string): string | undefined {
    return this.get(distro)?.runtimeHomePath
  }

  hasLastSyncedAccountId(distro: string): boolean {
    return this.get(distro)?.lastSyncedAccountId !== undefined
  }

  getLastSyncedAccountId(distro: string): string | null | undefined {
    return this.get(distro)?.lastSyncedAccountId
  }

  getLastWrittenAuthJson(distro: string): string | null | undefined {
    return this.get(distro)?.lastWrittenAuthJson
  }

  setRuntimeHomePath(distro: string, runtimeHomePath: string): void {
    this.update(distro, { runtimeHomePath })
  }

  setLastSyncedAccountId(distro: string, accountId: string | null): void {
    this.update(distro, { lastSyncedAccountId: accountId })
  }

  setLastWrittenAuthJson(distro: string, authJson: string | null): void {
    this.update(distro, { lastWrittenAuthJson: authJson })
  }

  evidence(): { entries: number; retainedBytes: number } {
    return { entries: this.entries.size, retainedBytes: this.retainedBytes }
  }

  private get(distro: string): CodexWslRuntimeHomeEntry | undefined {
    const entry = this.entries.get(distro)
    if (entry) {
      this.entries.delete(distro)
      this.entries.set(distro, entry)
    }
    return entry
  }

  private update(
    distro: string,
    patch: Omit<Partial<CodexWslRuntimeHomeEntry>, 'retainedBytes'>
  ): void {
    const previous = this.entries.get(distro)
    const next = { ...previous, ...patch, retainedBytes: 0 }
    const retainedBytes = this.measureEntry(distro, next)
    this.delete(distro)
    if (retainedBytes === null || retainedBytes > this.bounds.maxTotalBytes) {
      return
    }
    while (
      this.entries.size >= this.bounds.maxEntries ||
      this.retainedBytes + retainedBytes > this.bounds.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        return
      }
      this.delete(oldest)
    }
    next.retainedBytes = retainedBytes
    this.entries.set(distro, next)
    this.retainedBytes += retainedBytes
  }

  private measureEntry(distro: string, entry: CodexWslRuntimeHomeEntry): number | null {
    const keyBytes = measureUtf8ByteLength(distro, {
      stopAfterBytes: this.bounds.maxKeyBytes
    })
    if (keyBytes.exceededLimit) {
      return null
    }
    let retainedBytes = keyBytes.byteLength
    for (const value of [
      entry.runtimeHomePath,
      entry.lastWrittenAuthJson,
      entry.lastSyncedAccountId
    ]) {
      if (typeof value !== 'string') {
        continue
      }
      const valueBytes = measureUtf8ByteLength(value, {
        stopAfterBytes: this.bounds.maxValueBytes
      })
      if (valueBytes.exceededLimit) {
        return null
      }
      retainedBytes += valueBytes.byteLength
    }
    return retainedBytes
  }

  private delete(distro: string): void {
    const entry = this.entries.get(distro)
    if (!entry) {
      return
    }
    this.entries.delete(distro)
    this.retainedBytes -= entry.retainedBytes
  }
}
