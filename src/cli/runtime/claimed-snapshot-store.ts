/** Per-release copies under a profile root; live PID claims keep a copy from cleanup while launches use it. */
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const COMPLETE_MARKER = '.complete'
const USERS_DIR = '.users'
const TEMPORARY_PREFIX = '.tmp-'

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Keep PID claims outside snapshots so they cannot block publication. */
export const snapshotUsersDir = (root: string, id: string): string => join(root, USERS_DIR, id)

/** Claims `root/id` for `pid`, publishing it from `populate` unless another launch already did. */
export async function publishClaimedSnapshot(
  root: string,
  id: string,
  pid: number,
  populate: (directory: string) => Promise<void>
): Promise<string> {
  // Claim before checking so concurrent cleanup preserves this snapshot.
  await mkdir(snapshotUsersDir(root, id), { recursive: true })
  await writeFile(join(snapshotUsersDir(root, id), String(pid)), '')
  const snapshotDir = join(root, id)
  if (await exists(join(snapshotDir, COMPLETE_MARKER))) {
    return snapshotDir
  }
  const temporary = join(root, `${TEMPORARY_PREFIX}${pid}-${id}`)
  await rm(temporary, { recursive: true, force: true })
  try {
    await mkdir(temporary)
    await populate(temporary)
    await writeFile(join(temporary, COMPLETE_MARKER), '')
  } catch (error) {
    // Failed copies must not retain disk space for the service’s lifetime.
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temporary, snapshotDir)
  } catch (error) {
    // Another launch for this profile finished the same release first.
    await rm(temporary, { recursive: true, force: true })
    if (!(await exists(join(snapshotDir, COMPLETE_MARKER)))) {
      throw error
    }
  }
  return snapshotDir
}

function isLivePidName(name: string, isProcessAlive: (pid: number) => boolean): boolean {
  const pid = Number(name)
  return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)
}

export async function removeUnusedSnapshots(
  root: string,
  keep: string,
  isProcessAlive: (pid: number) => boolean
): Promise<void> {
  for (const name of await readdir(root).catch(() => [])) {
    if (name === keep || name === USERS_DIR) {
      continue
    }
    const inUse = name.startsWith(TEMPORARY_PREFIX)
      ? isLivePidName(name.slice(TEMPORARY_PREFIX.length).split('-')[0], isProcessAlive)
      : (await readdir(snapshotUsersDir(root, name)).catch(() => [])).some((pid) =>
          isLivePidName(pid, isProcessAlive)
        )
    if (!inUse) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)
      await rm(snapshotUsersDir(root, name), { recursive: true, force: true }).catch(
        () => undefined
      )
    }
  }
}
