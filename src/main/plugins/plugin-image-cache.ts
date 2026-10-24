import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_IMAGE_MIME, readPluginImageHeader } from '../../shared/plugins/plugin-image-format'

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
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, bytes)
    await rename(temporary, target)
    return sha256
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
