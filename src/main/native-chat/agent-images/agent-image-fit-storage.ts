import { join } from 'node:path'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot,
  sweepExpiredOwnedDirectories
} from '../../filesystem/owned-temp-staging-root'

const COPY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const COPY_BUCKET = /^\d{4}-\d{2}-\d{2}$/
const swept = new Set<string>()

export function transientAgentImageDirectory(
  temp: string,
  now = Date.now()
): { directory: string; root: string } {
  const root = getOwnedTempStagingRoot(temp, 'orca-agent-images')
  return { root, directory: join(root, new Date(now).toISOString().slice(0, 10)) }
}

/** One bounded sweep per worker lifetime; date buckets keep it independent of image count. */
export async function prepareTransientAgentImages(root: string, now = Date.now()): Promise<void> {
  if (swept.has(root)) {
    return
  }
  if (!(await ensureOwnedTempStagingRoot(root))) {
    throw new Error('Image staging directory is unsafe')
  }
  await sweepExpiredOwnedDirectories(root, {
    nowMs: now,
    ttlMs: COPY_TTL_MS,
    ownsEntry: (name) => COPY_BUCKET.test(name),
    entryLimit: 64
  })
  swept.add(root)
}
