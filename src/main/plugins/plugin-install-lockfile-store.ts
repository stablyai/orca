import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  emptyPluginLockfile,
  parsePluginLockfile,
  serializePluginLockfile,
  type PluginLockfile
} from '../../shared/plugins/plugin-install-lockfile'
import { writePluginFileAtomically } from './plugin-atomic-file-write'
import { recoverPluginLockfile } from './plugin-install-provenance'

export const PLUGIN_LOCKFILE_MAX_BYTES = 5 * 1024 * 1024
const lockfileAccessChains = new Map<string, Promise<void>>()

export function pluginLockfilePath(pluginsDir: string): string {
  return join(pluginsDir, 'plugins.lock.json')
}

async function serializeLockfileAccess<T>(
  pluginsDir: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = lockfileAccessChains.get(pluginsDir) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  lockfileAccessChains.set(pluginsDir, settled)
  try {
    return await run
  } finally {
    if (lockfileAccessChains.get(pluginsDir) === settled) {
      lockfileAccessChains.delete(pluginsDir)
    }
  }
}

/** Reads the install index through a byte cap so a corrupt local file cannot
 * turn every plugin-list refresh into an unbounded main-process allocation. */
export async function readPluginLockfile(pluginsDir: string): Promise<PluginLockfile> {
  return serializeLockfileAccess(pluginsDir, () => readPluginLockfileUnserialized(pluginsDir))
}

async function readPluginLockfileUnserialized(pluginsDir: string): Promise<PluginLockfile> {
  let lock = emptyPluginLockfile()
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    for await (const chunk of createReadStream(pluginLockfilePath(pluginsDir))) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > PLUGIN_LOCKFILE_MAX_BYTES) {
        throw new Error('plugin lockfile exceeds its size limit')
      }
      chunks.push(bytes)
    }
    lock = parsePluginLockfile(JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')))
  } catch {
    // Missing/corrupt global indexes can be reconstructed from current-version provenance.
  }
  const recovered = await recoverPluginLockfile(pluginsDir, lock)
  if (recovered.changed) {
    await writePluginLockfileUnserialized(pluginsDir, recovered.lock).catch(() => undefined)
  }
  return recovered.lock
}

export async function writePluginLockfile(pluginsDir: string, lock: PluginLockfile): Promise<void> {
  await serializeLockfileAccess(pluginsDir, () => writePluginLockfileUnserialized(pluginsDir, lock))
}

async function writePluginLockfileUnserialized(
  pluginsDir: string,
  lock: PluginLockfile
): Promise<void> {
  await mkdir(pluginsDir, { recursive: true })
  await writePluginFileAtomically(
    pluginLockfilePath(pluginsDir),
    JSON.stringify(serializePluginLockfile(lock), null, 2)
  )
}
