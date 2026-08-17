import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SKILL_INSTALL_BUSY_FAILURE } from '../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'
import { skillInstallStateKey } from './skill-install-provenance'

const LOCK_RETRY_MS = 50
const LOCK_STALE_MS = 30 * 60 * 1000
const MAX_STARTUP_LOCKS = 128
const LOCK_NAME = /^[a-f0-9]{64}\.lock$/
const LOCK_OWNER_NAME = /^[a-f0-9]{64}\.lock\.[a-f0-9-]{36}\.owner$/
const activeLockTokens = new Set<string>()

type SkillInstallLockOwner = {
  token: string
  pid: number
  createdAt: number
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function removeStaleLock(path: string): Promise<void> {
  const lockStat = await stat(path).catch(() => null)
  if (!lockStat) {
    return
  }
  let owner: SkillInstallLockOwner | null = null
  try {
    owner = JSON.parse(await readFile(path, 'utf8')) as SkillInstallLockOwner
  } catch {
    owner = null
  }
  if (owner && Number.isInteger(owner.pid)) {
    if (owner.pid === process.pid && !activeLockTokens.has(owner.token)) {
      await rm(path, { force: true })
      return
    }
    if (processIsAlive(owner.pid)) {
      return
    }
    await rm(path, { force: true })
    return
  }
  if (Date.now() - lockStat.mtimeMs >= LOCK_STALE_MS) {
    await rm(path, { force: true })
  }
}

export async function reclaimDeadSkillInstallLocks(stateDirectory: string): Promise<{
  scanned: number
  reclaimed: number
  truncated: boolean
}> {
  const directory = join(stateDirectory, 'locks')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  })
  const locks = entries
    .filter(
      (entry) => entry.isFile() && (LOCK_NAME.test(entry.name) || LOCK_OWNER_NAME.test(entry.name))
    )
    .sort((left, right) => left.name.localeCompare(right.name))
  let reclaimed = 0
  for (const lock of locks.slice(0, MAX_STARTUP_LOCKS)) {
    const path = join(directory, lock.name)
    await removeStaleLock(path)
    if (!(await stat(path).catch(() => null))) {
      reclaimed += 1
    }
  }
  return {
    scanned: Math.min(locks.length, MAX_STARTUP_LOCKS),
    reclaimed,
    truncated: locks.length > MAX_STARTUP_LOCKS
  }
}

export function skillInstallLockPath(stateDirectory: string, canonicalPath: string): string {
  return join(stateDirectory, 'locks', `${skillInstallStateKey(canonicalPath)}.lock`)
}

export async function acquireSkillInstallLock(input: {
  path: string
  timeoutMs?: number
  removeLock?: (path: string) => Promise<void>
  writeOwner?: (handle: FileHandle, value: string) => Promise<void>
}): Promise<() => Promise<void>> {
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + (input.timeoutMs ?? 5_000)
  const owner: SkillInstallLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now()
  }
  for (;;) {
    const ownerPath = `${input.path}.${owner.token}.owner`
    const handle = await open(ownerPath, 'wx', 0o600)
    try {
      try {
        await (
          input.writeOwner ??
          (async (lockHandle, value) => {
            await lockHandle.writeFile(value, 'utf8')
            await lockHandle.sync()
          })
        )(handle, JSON.stringify(owner))
      } finally {
        await handle.close()
      }
    } catch (error) {
      await rm(ownerPath, { force: true }).catch(() => undefined)
      throw error
    }
    activeLockTokens.add(owner.token)
    try {
      try {
        await link(ownerPath, input.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
        await removeStaleLock(input.path)
        if (Date.now() >= deadline) {
          throw new SkillInstallOperationError(SKILL_INSTALL_BUSY_FAILURE)
        }
        activeLockTokens.delete(owner.token)
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
        continue
      }
      let releasePromise: Promise<void> | null = null
      return () => {
        releasePromise ??= (async () => {
          try {
            let current: SkillInstallLockOwner | null = null
            try {
              current = JSON.parse(await readFile(input.path, 'utf8')) as SkillInstallLockOwner
            } catch {
              current = null
            }
            if (current?.token === owner.token) {
              await (input.removeLock ?? ((path) => rm(path, { force: true })))(input.path)
            }
          } finally {
            activeLockTokens.delete(owner.token)
          }
        })()
        return releasePromise
      }
    } catch (error) {
      activeLockTokens.delete(owner.token)
      throw error
    } finally {
      await rm(ownerPath, { force: true }).catch(() => undefined)
    }
  }
}
