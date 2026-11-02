import { createHash } from 'node:crypto'
import { lstat, mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import { ensureOwnedTempStagingRoot } from '../window/owned-temp-staging-root'
import { agentSessionContextSnapshotRoot } from './agent-session-context-snapshots'

// 32 slots × 2 MiB cap recovery exports at 64 MiB per profile; 2 MiB of text already exceeds any model window.
export const RECOVERY_EXPORT_SLOTS = 32
export const RECOVERY_EXPORT_MAX_BYTES = 2 * 1024 * 1024

export function agentSessionRecoveryExportRoot(stateDirectory: string): string {
  return join(agentSessionContextSnapshotRoot(stateDirectory), 'recovery')
}

/** Immutable per-key export in a fixed slot; any doubt about the slot means no path, never a wait or overwrite. */
export async function publishAgentSessionRecoveryExport(
  stateDirectory: string,
  key: string,
  text: string
): Promise<string | undefined> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > RECOVERY_EXPORT_MAX_BYTES) {
    return undefined
  }
  const root = agentSessionContextSnapshotRoot(stateDirectory)
  if (!(await ensureOwnedTempStagingRoot(root))) {
    return undefined
  }
  const name = createHash('sha256').update(key).digest('hex')
  const slot = join(
    agentSessionRecoveryExportRoot(stateDirectory),
    `slot-${Number.parseInt(name.slice(0, 8), 16) % RECOVERY_EXPORT_SLOTS}`
  )
  const path = join(slot, `${name}.txt`)
  const published = await lstat(path).catch(() => undefined)
  if (published) {
    return published.isFile() && published.size === bytes.length && (await sameBytes(path, bytes))
      ? path
      : undefined
  }
  await mkdir(agentSessionRecoveryExportRoot(stateDirectory), { mode: 0o700 }).catch(
    () => undefined
  )
  try {
    // The exclusive directory is the claim, so separate processes cannot share a slot.
    await mkdir(slot, { mode: 0o700 })
  } catch {
    return undefined
  }
  const stage = `${path}.part`
  try {
    await writeFile(stage, bytes, { flag: 'wx', mode: 0o600 })
    if (!(await renameFileWithWindowsRetryAsync(stage, path))) {
      throw new Error('Recovery export was not published')
    }
    return path
  } catch {
    // Only this claim's own artifacts are removed; a failed cleanup leaves the slot consumed.
    await rm(stage, { force: true })
      .then(() => rmdir(slot))
      .catch(() => undefined)
    return undefined
  }
}

/** A bounded nonblocking read, so a file swapped for a FIFO or grown after lstat can't hang Send. */
async function sameBytes(path: string, bytes: Buffer): Promise<boolean> {
  try {
    const { buffer } = await readNodeFileWithinLimit(path, bytes.length, { regularFileOnly: true })
    return buffer.equals(bytes)
  } catch {
    return false
  }
}
