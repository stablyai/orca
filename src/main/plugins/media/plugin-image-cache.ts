import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../../shared/plugins/images/plugin-image-format'

const MAX_CACHED_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_CACHE_BYTES = 128 * 1024 * 1024
const IMAGE_HASH = /^[0-9a-f]{64}$/

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Verified plugin and catalog images, addressed by SHA-256 so a name can never change meaning. */
export class PluginImageCache {
  private readonly sizes = new Map<string, number>()
  private usedBytes = 0
  private initialization?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly maxBytes = MAX_IMAGE_CACHE_BYTES
  ) {}

  async put(bytes: Uint8Array): Promise<string | null> {
    if (
      bytes.byteLength > Math.min(MAX_CACHED_IMAGE_BYTES, this.maxBytes) ||
      typeof readPluginImageHeader(bytes) === 'string'
    ) {
      return null
    }
    const sha256 = sha256Hex(bytes)
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.initialize()
        const target = join(this.directory, sha256)
        if (!(await this.readVerified(sha256))) {
          this.forget(sha256)
          if (!(await this.evict(this.maxBytes - bytes.byteLength))) {
            return null
          }
          const temporary = `${target}.${randomUUID()}.tmp`
          try {
            await writeFile(temporary, bytes)
            await rename(temporary, target)
          } catch (error) {
            if (!(await this.readVerified(sha256))) {
              throw error
            }
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined)
          }
        }
        this.remember(sha256, bytes.byteLength)
        return sha256
      })
    this.writes = write
    return write
  }

  private initialize(): Promise<void> {
    if (!this.initialization) {
      const initialize = this.loadIndex()
      this.initialization = initialize
      void initialize.catch(() => {
        this.initialization = undefined
      })
    }
    return this.initialization
  }

  private async loadIndex(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const entries: { name: string; size: number; modified: number }[] = []
    for (const name of await readdir(this.directory)) {
      if (/^[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(name)) {
        await rm(join(this.directory, name), { force: true }).catch(() => undefined)
      } else if (IMAGE_HASH.test(name)) {
        const stat = await lstat(join(this.directory, name)).catch(() => null)
        if (stat?.isFile()) {
          entries.push({ name, size: stat.size, modified: stat.mtimeMs })
        }
      }
    }
    this.sizes.clear()
    this.usedBytes = 0
    for (const entry of entries.sort((left, right) => left.modified - right.modified)) {
      this.remember(entry.name, entry.size)
    }
    await this.evict(this.maxBytes)
  }

  private forget(sha256: string): void {
    this.usedBytes -= this.sizes.get(sha256) ?? 0
    this.sizes.delete(sha256)
  }

  private remember(sha256: string, size: number): void {
    this.forget(sha256)
    this.sizes.set(sha256, size)
    this.usedBytes += size
  }

  private async evict(limit: number): Promise<boolean> {
    if (this.usedBytes <= limit) {
      return true
    }
    // Cache hits can reorder the index while a deletion is pending.
    const candidates = [...this.sizes.keys()]
    for (const sha256 of candidates) {
      if (
        await rm(join(this.directory, sha256), { force: true }).then(
          () => true,
          () => false
        )
      ) {
        this.forget(sha256)
        if (this.usedBytes <= limit) {
          return true
        }
      }
    }
    return false
  }

  private async readVerified(sha256: string): Promise<Buffer | null> {
    const bytes = await readFile(join(this.directory, sha256)).catch(() => null)
    return bytes && sha256Hex(bytes) === sha256 ? bytes : null
  }

  /** The bytes and MIME type for a hash, re-verified on every read. */
  async get(sha256: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    if (!IMAGE_HASH.test(sha256)) {
      return null
    }
    await this.initialize()
    const bytes = await this.readVerified(sha256)
    if (!bytes) {
      return null
    }
    if (this.sizes.has(sha256)) {
      this.remember(sha256, bytes.byteLength)
    }
    const info = readPluginImageHeader(bytes)
    return typeof info === 'string' ? null : { bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] }
  }
}
