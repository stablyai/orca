import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  if (Buffer.byteLength(text, 'utf8') > RECOVERY_EXPORT_MAX_BYTES) {
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
  const published = await readFile(path, 'utf8').catch(() => undefined)
  if (published !== undefined) {
    return published === text ? path : undefined
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
    await writeFile(stage, text, { flag: 'wx', mode: 0o600 })
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
