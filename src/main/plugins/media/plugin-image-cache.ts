import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../../shared/plugins/images/plugin-image-format'

const MAX_CACHED_IMAGE_BYTES = 2 * 1024 * 1024
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024
// Why a grace window: preview images are not in any catalog snapshot and may be open in a dialog.
const DEFAULT_PRUNE_MIN_AGE_MS = 30 * 60 * 1000
const SWEEP_WRITE_THRESHOLD_BYTES = 32 * 1024 * 1024

export type PluginImageCacheOptions = {
  maxBytes?: number
  minAgeMs?: number
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Verified plugin and catalog images, addressed by SHA-256 so a name can never change meaning. */
export class PluginImageCache {
  private readonly maxBytes: number
  private readonly minAgeMs: number
  private sweepChain: Promise<unknown> = Promise.resolve()
  private bytesWrittenSinceSweep = 0

  constructor(
    private readonly directory: string,
    options: PluginImageCacheOptions = {}
  ) {
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES)
    this.minAgeMs = Math.max(0, options.minAgeMs ?? DEFAULT_PRUNE_MIN_AGE_MS)
  }

  async put(bytes: Uint8Array): Promise<string | null> {
    if (
      bytes.byteLength > MAX_CACHED_IMAGE_BYTES ||
      typeof readPluginImageHeader(bytes) === 'string'
    ) {
      return null
    }
    const sha256 = sha256Hex(bytes)
    await mkdir(this.directory, { recursive: true })
    const target = join(this.directory, sha256)
    if (await this.holds(target, sha256)) {
      const now = new Date()
      await utimes(target, now, now).catch(() => undefined)
      return sha256
    }
    // Unique per write: concurrent saves of the same image must not share a temp file.
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, target)
    } catch (error) {
      // Content-addressed: a concurrent writer that already produced the file is a success
      // (Windows rejects renaming over a file another handle has open).
      if (!(await this.holds(target, sha256))) {
        throw error
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    this.bytesWrittenSinceSweep += bytes.byteLength
    const sweepThreshold = Math.min(this.maxBytes, SWEEP_WRITE_THRESHOLD_BYTES)
    if (this.maxBytes > 0 && this.bytesWrittenSinceSweep >= sweepThreshold) {
      this.bytesWrittenSinceSweep = 0
      void this.enforceMaxBytes().catch(() => undefined)
    }
    return sha256
  }

  /** Removes unreferenced images older than `minAgeMs` and enforces the total byte cap. */
  prune(
    retain: ReadonlySet<string>,
    options: { now?: number; minAgeMs?: number; maxBytes?: number } = {}
  ): Promise<number> {
    return this.runSweep(() => this.performPrune(retain, options))
  }

  private enforceMaxBytes(): Promise<number> {
    return this.runSweep(() => this.performSizeSweep(this.maxBytes))
  }

  private runSweep<T>(task: () => Promise<T>): Promise<T> {
    const run = this.sweepChain.catch(() => undefined).then(task)
    this.sweepChain = run
    return run
  }

  private async performPrune(
    retain: ReadonlySet<string>,
    options: { now?: number; minAgeMs?: number; maxBytes?: number }
  ): Promise<number> {
    const now = options.now ?? Date.now()
    const minAgeMs = Math.max(0, options.minAgeMs ?? this.minAgeMs)
    const maxBytes = Math.max(0, options.maxBytes ?? this.maxBytes)
    const entries = await this.listEntries()
    if (!entries) {
      return 0
    }
    let removed = 0
    let totalBytes = 0
    const kept: { path: string; size: number; mtimeMs: number; retained: boolean }[] = []
    for (const entry of entries) {
      const fullPath = join(this.directory, entry.name)
      const isHash = SHA256_HEX_PATTERN.test(entry.name)
      const isTemp = entry.name.endsWith('.tmp')
      if (!isHash && !isTemp) {
        continue
      }
      const info = await stat(fullPath).catch(() => null)
      if (!info || !info.isFile()) {
        continue
      }
      const ageMs = now - info.mtimeMs
      if (isTemp) {
        if (ageMs >= minAgeMs) {
          await rm(fullPath, { force: true }).catch(() => undefined)
        }
        continue
      }
      const retained = retain.has(entry.name)
      if (!retained && ageMs >= minAgeMs) {
        await rm(fullPath, { force: true }).catch(() => undefined)
        removed += 1
        continue
      }
      totalBytes += info.size
      kept.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs, retained })
    }
    if (totalBytes > maxBytes) {
      kept.sort((a, b) => Number(a.retained) - Number(b.retained) || a.mtimeMs - b.mtimeMs)
      for (const candidate of kept) {
        if (totalBytes <= maxBytes) {
          break
        }
        await rm(candidate.path, { force: true }).catch(() => undefined)
        totalBytes -= candidate.size
        removed += 1
      }
    }
    return removed
  }

  private async performSizeSweep(maxBytes: number): Promise<number> {
    const entries = await this.listEntries()
    if (!entries) {
      return 0
    }
    const now = Date.now()
    let totalBytes = 0
    const evictable: { path: string; size: number; mtimeMs: number }[] = []
    for (const entry of entries) {
      if (!SHA256_HEX_PATTERN.test(entry.name)) {
        continue
      }
      const fullPath = join(this.directory, entry.name)
      const info = await stat(fullPath).catch(() => null)
      if (!info || !info.isFile()) {
        continue
      }
      totalBytes += info.size
      // Keep recently written images (active previews and in-flight refreshes) within the grace window.
      if (now - info.mtimeMs >= this.minAgeMs) {
        evictable.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
    if (totalBytes <= maxBytes) {
      return 0
    }
    evictable.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    for (const candidate of evictable) {
      if (totalBytes <= maxBytes) {
        break
      }
      await rm(candidate.path, { force: true }).catch(() => undefined)
      totalBytes -= candidate.size
      removed += 1
    }
    return removed
  }

  private async listEntries() {
    try {
      return await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  private async holds(target: string, sha256: string): Promise<boolean> {
    const existing = await readFile(target).catch(() => null)
    return existing !== null && sha256Hex(existing) === sha256
  }

  /** The bytes and MIME type for a hash, re-verified on every read. */
  async get(sha256: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    if (!SHA256_HEX_PATTERN.test(sha256)) {
      return null
    }
    const bytes = await readFile(join(this.directory, sha256)).catch(() => null)
    if (!bytes || sha256Hex(bytes) !== sha256) {
      return null
    }
    const info = readPluginImageHeader(bytes)
    return typeof info === 'string' ? null : { bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] }
  }
}
