import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../shared/plugins/images/plugin-image-format'

const MAX_CACHED_IMAGE_BYTES = 2 * 1024 * 1024

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Verified plugin and catalog images, addressed by SHA-256 so a name can never change meaning. */
export class PluginImageCache {
  constructor(private readonly directory: string) {}

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
    return sha256
  }

  private async holds(target: string, sha256: string): Promise<boolean> {
    const existing = await readFile(target).catch(() => null)
    return existing !== null && sha256Hex(existing) === sha256
  }

  /** The bytes and MIME type for a hash, re-verified on every read. */
  async get(sha256: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
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
