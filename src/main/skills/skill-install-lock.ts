import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SKILL_INSTALL_BUSY_FAILURE } from '../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'
import {
  readSkillInstallLockOwner,
  skillInstallLockOwnerProcessIsAlive,
  type SkillInstallLockOwner
} from './skill-install-lock-owner'
import {
  cleanupReleasedSkillInstallLock,
  reclaimReleasedSkillInstallLock
} from './skill-install-lock-release'
import { skillInstallStateKey } from './skill-install-provenance'

const LOCK_RETRY_MS = 50
const LOCK_STALE_MS = 30 * 60 * 1000
const MAX_STARTUP_LOCKS = 128
const LOCK_NAME = /^[a-f0-9]{64}\.lock$/
const LEGACY_OWNER_NAME = /^[a-f0-9]{64}\.lock\.[a-f0-9-]{36}\.owner$/
const CANDIDATE_LOCK_NAME = /^[a-f0-9]{64}\.lock\.[a-f0-9-]{36}\.candidate$/
const RELEASED_LOCK_NAME = /^[a-f0-9]{64}\.lock\.[a-f0-9-]{36}\.released$/
const OWNER_ENTRY_NAME = /^([a-f0-9-]{36})\.owner$/
const RELEASE_ENTRY_NAME = /^([a-f0-9-]{36})\.released$/
const activeLockTokens = new Set<string>()

function ownerIsReclaimable(owner: SkillInstallLockOwner): boolean {
  if (owner.pid === process.pid && !activeLockTokens.has(owner.token)) {
    return true
  }
  return !skillInstallLockOwnerProcessIsAlive(owner)
}

async function removeObservedLegacyFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return
    }
    if (
      (code === 'EISDIR' || code === 'EPERM') &&
      (await stat(path).catch(() => null))?.isDirectory()
    ) {
      return
    }
    throw error
  }
}

async function removeStaleLegacyLock(path: string): Promise<void> {
  const lockStat = await stat(path).catch(() => null)
  if (!lockStat?.isFile()) {
    return
  }
  const owner = await readSkillInstallLockOwner(path)
  if (owner ? ownerIsReclaimable(owner) : Date.now() - lockStat.mtimeMs >= LOCK_STALE_MS) {
    await removeObservedLegacyFile(path)
  }
}

async function removeStaleLockDirectory(path: string, incompleteStaleMs = 0): Promise<void> {
  const lockStat = await stat(path).catch(() => null)
  if (!lockStat?.isDirectory()) {
    return
  }
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (!entries) {
    return
  }
  const releasedTokens = new Set(
    entries.flatMap((entry) => {
      const match = entry.isFile() ? RELEASE_ENTRY_NAME.exec(entry.name) : null
      return match?.[1] ? [match[1]] : []
    })
  )
  let mayRemoveDirectory = releasedTokens.size > 0
  for (const entry of entries) {
    const match = entry.isFile() ? OWNER_ENTRY_NAME.exec(entry.name) : null
    if (!match?.[1]) {
      continue
    }
    const ownerPath = join(path, entry.name)
    const owner = await readSkillInstallLockOwner(ownerPath)
    const ownerStat = owner ? null : await stat(ownerPath).catch(() => null)
    const reclaimable =
      releasedTokens.has(match[1]) ||
      (owner
        ? ownerIsReclaimable(owner)
        : Boolean(ownerStat && Date.now() - ownerStat.mtimeMs >= incompleteStaleMs))
    if (!reclaimable) {
      return
    }
    await unlink(ownerPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    })
    mayRemoveDirectory = true
  }
  for (const token of releasedTokens) {
    await unlink(join(path, `${token}.released`)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    })
  }
  if (!mayRemoveDirectory && Date.now() - lockStat.mtimeMs < incompleteStaleMs) {
    return
  }
  await rmdir(path).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw error
    }
  })
}

async function removeStaleLock(path: string): Promise<void> {
  const lockStat = await stat(path).catch(() => null)
  if (lockStat?.isDirectory()) {
    await removeStaleLockDirectory(path)
  } else if (lockStat?.isFile()) {
    await removeStaleLegacyLock(path)
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
      (entry) =>
        (LOCK_NAME.test(entry.name) && (entry.isFile() || entry.isDirectory())) ||
        (entry.isFile() && LEGACY_OWNER_NAME.test(entry.name)) ||
        (entry.isDirectory() && CANDIDATE_LOCK_NAME.test(entry.name)) ||
        (entry.isDirectory() && RELEASED_LOCK_NAME.test(entry.name))
    )
    .sort((left, right) => left.name.localeCompare(right.name))
  let reclaimed = 0
  for (const lock of locks.slice(0, MAX_STARTUP_LOCKS)) {
    const path = join(directory, lock.name)
    await (LEGACY_OWNER_NAME.test(lock.name)
      ? removeStaleLegacyLock(path)
      : CANDIDATE_LOCK_NAME.test(lock.name)
        ? removeStaleLockDirectory(path, LOCK_STALE_MS)
        : RELEASED_LOCK_NAME.test(lock.name)
          ? reclaimReleasedSkillInstallLock(path)
          : removeStaleLock(path))
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

async function writeOwnerRecord(
  path: string,
  value: string,
  writer?: (handle: FileHandle, value: string) => Promise<void>
): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await (
      writer ??
      (async (lockHandle, record) => {
        await lockHandle.writeFile(record, 'utf8')
        await lockHandle.sync()
      })
    )(handle, value)
  } finally {
    await handle.close()
  }
}

async function markReleased(path: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function acquireSkillInstallLock(input: {
  path: string
  timeoutMs?: number
  removeLock?: (path: string) => Promise<void>
  publishLock?: (candidatePath: string, lockPath: string) => Promise<void>
  writeOwner?: (handle: FileHandle, value: string) => Promise<void>
}): Promise<() => Promise<void>> {
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + (input.timeoutMs ?? 5_000)
  const owner: SkillInstallLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now()
  }
  const ownerRecord = JSON.stringify(owner)
  const candidatePath = `${input.path}.${owner.token}.candidate`
  const candidateOwnerPath = join(candidatePath, `${owner.token}.owner`)
  const ownerPath = join(input.path, `${owner.token}.owner`)
  const releasedPath = `${input.path}.${owner.token}.released`
  await mkdir(candidatePath, { mode: 0o700 })
  activeLockTokens.add(owner.token)
  let published = false
  try {
    await writeOwnerRecord(candidateOwnerPath, ownerRecord, input.writeOwner)
    for (;;) {
      try {
        await (input.publishLock ?? rename)(candidatePath, input.path)
        published = true
        break
      } catch (error) {
        if (!(await stat(candidatePath).catch(() => null))?.isDirectory()) {
          throw error
        }
        if (await stat(input.path).catch(() => null)) {
          await removeStaleLock(input.path)
        }
        if (!(await stat(input.path).catch(() => null))) {
          if (Date.now() >= deadline) {
            throw error
          }
          await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
          continue
        }
        if (Date.now() >= deadline) {
          throw new SkillInstallOperationError(SKILL_INSTALL_BUSY_FAILURE)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
  } finally {
    if (!published) {
      activeLockTokens.delete(owner.token)
      await unlink(candidateOwnerPath).catch(() => undefined)
      await rmdir(candidatePath).catch(() => undefined)
    }
  }
  let releasePromise: Promise<void> | null = null
  return () => {
    releasePromise ??= (async () => {
      try {
        if ((await readSkillInstallLockOwner(ownerPath))?.token !== owner.token) {
          return
        }
        await markReleased(join(input.path, `${owner.token}.released`))
        try {
          await rename(input.path, releasedPath)
        } catch (error) {
          if ((await readSkillInstallLockOwner(ownerPath))?.token === owner.token) {
            throw error
          }
          return
        }
        await cleanupReleasedSkillInstallLock(releasedPath, owner.token, input.removeLock)
      } finally {
        activeLockTokens.delete(owner.token)
      }
    })()
    return releasePromise
  }
}
