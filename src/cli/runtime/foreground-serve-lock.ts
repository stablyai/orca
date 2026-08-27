import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK_DIR_NAME = 'orca-serve.lock'
const OWNER_FILE_NAME = 'owner.json'
const ACQUIRE_ATTEMPTS = 5

export type ForegroundServeLock = {
  path: string
  pid: number
}

type LockRecord = {
  pid: number
  startedAt: number
}

export function getForegroundServeLockPath(userDataPath: string): string {
  return join(userDataPath, LOCK_DIR_NAME)
}

export function getForegroundServeLockOwnerPath(userDataPath: string): string {
  return join(getForegroundServeLockPath(userDataPath), OWNER_FILE_NAME)
}

export async function acquireForegroundServeLock(
  userDataPath: string,
  pid = process.pid
): Promise<ForegroundServeLock | null> {
  await mkdir(userDataPath, { recursive: true })
  const lockDir = getForegroundServeLockPath(userDataPath)
  const ownerPath = join(lockDir, OWNER_FILE_NAME)

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockDir)
      await writeFile(ownerPath, serializeLock({ pid, startedAt: Date.now() }), {
        encoding: 'utf8',
        mode: 0o600
      })
      return { path: lockDir, pid }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        continue
      }
      if (code !== 'EEXIST') {
        throw error
      }
      const existing = await readLockRecord(ownerPath)
      if (existing && isLockOwnerAlive(existing.pid)) {
        return null
      }
      // Why: a peer may have mkdir'd but not yet written owner.json. Wait
      // before treating a missing record as stale, so we do not rename a
      // successor's new lock aside.
      if (!existing && attempt < ACQUIRE_ATTEMPTS - 1) {
        await yieldEventLoop()
        continue
      }
      const staleDir = `${lockDir}.stale.${pid}.${attempt}`
      try {
        await rename(lockDir, staleDir)
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw renameError
      }
      await rm(staleDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return null
}

export async function releaseForegroundServeLock(lock: ForegroundServeLock): Promise<void> {
  const existing = await readLockRecord(join(lock.path, OWNER_FILE_NAME))
  if (existing?.pid !== lock.pid) {
    return
  }
  await rm(lock.path, { recursive: true, force: true }).catch(() => undefined)
}

function serializeLock(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`
}

async function readLockRecord(path: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null
    }
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
    }
  } catch {
    return null
  }
}

function isLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: EPERM means the pid exists but we cannot signal it. Treat as live so
    // we do not steal a lock from another session.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}
