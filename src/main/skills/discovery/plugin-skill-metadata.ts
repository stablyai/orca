import { open, stat } from 'node:fs/promises'
import { stripUnsafeDisplayCharacters } from '../../../shared/text/display-text-safety'

const MAX_PLUGIN_METADATA_BYTES = 4 * 1024 * 1024

export function safePluginLabel(packageName: string): string {
  const safeLabel = stripUnsafeDisplayCharacters(packageName).slice(0, 80)
  return safeLabel || 'plugin'
}

/** A plugin's metadata file, or null when it is missing, not a file, too large or unreadable. */
export async function readPluginMetadataFile(
  pathValue: string,
  signal?: AbortSignal,
  maxBytes = MAX_PLUGIN_METADATA_BYTES
): Promise<string | null> {
  try {
    signal?.throwIfAborted()
    const fileStat = await stat(pathValue)
    signal?.throwIfAborted()
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      return null
    }
    const file = await open(pathValue, 'r')
    try {
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(fileStat.size)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      signal?.throwIfAborted()
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    signal?.throwIfAborted()
    return null
  }
}
