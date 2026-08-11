import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writePluginFileAtomically } from './plugin-atomic-file-write'

export const PLUGIN_CURRENT_POINTER_FILENAME = 'current'
export const PLUGIN_CURRENT_POINTER_MAX_BYTES = 128

/** Reads the tiny hash pointer through a cap so discovery cannot allocate a
 * corrupt sparse file during startup. Missing pointers resolve to null. */
export async function readPluginCurrentPointer(pluginDir: string): Promise<string | null> {
  const target = join(pluginDir, PLUGIN_CURRENT_POINTER_FILENAME)
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for await (const chunk of createReadStream(target)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > PLUGIN_CURRENT_POINTER_MAX_BYTES) {
        throw new Error('current-version pointer exceeds its size limit')
      }
      chunks.push(bytes)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8').trim()
}

export async function writePluginCurrentPointer(
  pluginDir: string,
  contentHash: string
): Promise<void> {
  await writePluginFileAtomically(join(pluginDir, PLUGIN_CURRENT_POINTER_FILENAME), contentHash)
}

export async function restorePluginCurrentPointer(
  pluginDir: string,
  previousContentHash: string | null
): Promise<void> {
  if (previousContentHash === null) {
    await rm(join(pluginDir, PLUGIN_CURRENT_POINTER_FILENAME), { force: true })
    return
  }
  await writePluginCurrentPointer(pluginDir, previousContentHash)
}
