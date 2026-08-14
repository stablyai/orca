import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK_FILE_NAME = 'orca-serve.lock'
const ACQUIRE_ATTEMPTS = 3

export type ForegroundServeLock = {
  path: string
  pid: number
}

type LockRecord = {
  pid: number
  startedAt: number
}

export function getForegroundServeLockPath(userDataPath: string): string {
  return join(userDataPath, LOCK_FILE_NAME)
}

export async function acquireForegroundServeLock(
  userDataPath: string,
  pid = process.pid
): Promise<ForegroundServeLock | null> {
  await mkdir(userDataPath, { recursive: true })
  const path = getForegroundServeLockPath(userDataPath)

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(path, serializeLock({ pid, startedAt: Date.now() }), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
      return { path, pid }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      const existing = await readLockRecord(path)
      if (existing && isLockOwnerAlive(existing.pid)) {
        return null
      }
      await unlink(path).catch(() => undefined)
    }
  }
  return null
}

export async function releaseForegroundServeLock(lock: ForegroundServeLock): Promise<void> {
  const existing = await readLockRecord(lock.path)
  if (existing?.pid !== lock.pid) {
    return
  }
  await unlink(lock.path).catch(() => undefined)
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
