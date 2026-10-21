import { createHash } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import { durableWriteTempPath } from '../../durable-file-write'
import { profileStateAccessBootIdentity } from './profile-state-access-identity'
import { profileStateAccessPidNamespace } from './profile-state-access-owner'
import { basename, dirname, join } from 'node:path'

const ORPHAN_AGE_MS = 60 * 60_000
const BACKUP_TEMP_PATTERN =
  /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db\.owner-([a-f0-9]{64})\.([1-9]\d*)\.\d+\.[0-9a-f]+\.tmp(?:-(?:wal|shm|journal))?$/

export function profileStateBackupTemporaryPath(targetPath: string): string {
  const scope = currentProcessScope()
  return durableWriteTempPath(scope ? `${targetPath}.owner-${scope}` : targetPath)
}

function currentProcessScope(): string | undefined {
  const boot = profileStateAccessBootIdentity()
  const namespace = profileStateAccessPidNamespace()
  if (!boot || (process.platform === 'linux' && namespace === null)) {
    return undefined
  }
  return createHash('sha256')
    .update(JSON.stringify([process.platform, boot, namespace]))
    .digest('hex')
}

/** A dead process proves the temporary database and its journals cannot still be in use. */
export async function removeAbandonedProfileStateBackupFiles(
  databasePath: string,
  now: number
): Promise<void> {
  const scope = currentProcessScope()
  if (!scope) {
    return
  }
  const directory = dirname(databasePath)
  const prefix = `${basename(databasePath)}.backup.`
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) {
      continue
    }
    const match = BACKUP_TEMP_PATTERN.exec(name.slice(prefix.length))
    if (!match || match[2] !== scope || !ownerExited(Number(match[3]))) {
      continue
    }
    const path = join(directory, name)
    try {
      const info = await lstat(path)
      if (info.isFile() && now - info.mtimeMs >= ORPHAN_AGE_MS) {
        await rm(path, { force: true })
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
}

function ownerExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}
