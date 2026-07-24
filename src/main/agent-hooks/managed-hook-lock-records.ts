import { randomUUID } from 'node:crypto'
import { link, lstat, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readManagedHookProcessIdentity } from './managed-hook-owner-identity'

const UUID_PATTERN = '[\\da-f]{8}-[\\da-f]{4}-[1-5][\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}'
const OWNER_FILE_PATTERN = new RegExp(
  `^managed-hook-install\\.owner-(${UUID_PATTERN})\\.json$`,
  'i'
)
const OWNER_DRAFT_PATTERN = new RegExp(
  `^managed-hook-install\\.owner-draft-(${UUID_PATTERN})\\.json$`,
  'i'
)
export const CLAIMED_OWNER_PATTERN = new RegExp(
  `^managed-hook-install\\.claimed-(${UUID_PATTERN})-(${UUID_PATTERN})\\.json$`,
  'i'
)
const CLAIM_RECORD_PATTERN = new RegExp(
  `^managed-hook-install\\.claim-(${UUID_PATTERN})-(${UUID_PATTERN})\\.json$`,
  'i'
)
const activeOwnerTokens = new Set<string>()

export type ManagedHookLockOwner = {
  token: string
  pid: number
  hostIdentity: string
  processIdentity: string
}

export type ManagedHookLockClaim = {
  ownerToken: string
  claimToken: string
  pid: number
  hostIdentity: string
  processIdentity: string
}

export type ManagedHookLockState =
  | { kind: 'missing' }
  | { kind: 'owned'; owner: ManagedHookLockOwner }
  | { kind: 'unknown' }

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function ownerFileName(token: string): string {
  return `managed-hook-install.owner-${token}.json`
}

function ownerDraftFileName(token: string): string {
  return `managed-hook-install.owner-draft-${token}.json`
}

export function claimedOwnerFileName(ownerToken: string, claimToken: string): string {
  return `managed-hook-install.claimed-${ownerToken}-${claimToken}.json`
}

export function claimRecordFileName(ownerToken: string, claimToken: string): string {
  return `managed-hook-install.claim-${ownerToken}-${claimToken}.json`
}

export function deactivateManagedHookLockOwner(ownerToken: string): void {
  activeOwnerTokens.delete(ownerToken)
}

export function isManagedHookLockOwnerActive(ownerToken: string): boolean {
  return activeOwnerTokens.has(ownerToken)
}

export function parseOwner(value: string, token: string): ManagedHookLockOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<ManagedHookLockOwner>
    if (
      owner.token !== token ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.hostIdentity !== 'string' ||
      owner.hostIdentity.length === 0 ||
      typeof owner.processIdentity !== 'string' ||
      owner.processIdentity.length === 0
    ) {
      return null
    }
    return owner as ManagedHookLockOwner
  } catch {
    return null
  }
}

export function parseClaim(
  value: string,
  ownerToken: string,
  claimToken: string
): ManagedHookLockClaim | null {
  try {
    const claim = JSON.parse(value) as Partial<ManagedHookLockClaim>
    if (
      claim.ownerToken !== ownerToken ||
      claim.claimToken !== claimToken ||
      !Number.isSafeInteger(claim.pid) ||
      (claim.pid ?? 0) <= 0 ||
      typeof claim.hostIdentity !== 'string' ||
      claim.hostIdentity.length === 0 ||
      typeof claim.processIdentity !== 'string' ||
      claim.processIdentity.length === 0
    ) {
      return null
    }
    return claim as ManagedHookLockClaim
  } catch {
    return null
  }
}

export async function removeFileIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

export async function inspectManagedHookLock(lockPath: string): Promise<ManagedHookLockState> {
  let rawOwner: string
  try {
    rawOwner = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return { kind: 'missing' }
    }
    // Why: an older relay may own the canonical path as a directory.
    return { kind: 'unknown' }
  }
  try {
    const parsed = JSON.parse(rawOwner) as Partial<ManagedHookLockOwner>
    const owner = typeof parsed.token === 'string' ? parseOwner(rawOwner, parsed.token) : null
    return owner ? { kind: 'owned', owner } : { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' }
  }
}

export async function tryCreateManagedHookLock(
  lockParent: string,
  lockPath: string,
  hostIdentity: string,
  processIdentity: string
): Promise<ManagedHookLockOwner | null> {
  const token = randomUUID()
  const owner = { token, pid: process.pid, hostIdentity, processIdentity }
  const ownerPath = join(lockParent, ownerFileName(token))
  const draftPath = join(lockParent, ownerDraftFileName(token))
  await writeFile(draftPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    // Why: the final owner name appears only after its complete record is durable.
    await rename(draftPath, ownerPath)
    try {
      // Why: hard-link creation publishes metadata atomically and never replaces a lock.
      await link(ownerPath, lockPath)
      // Why: publish process-local activity before another same-process contender
      // can mistake the newly linked owner for an abandoned release.
      activeOwnerTokens.add(token)
      return owner
    } catch (error) {
      if (hasCode(error, 'EEXIST')) {
        return null
      }
      throw error
    }
  } finally {
    await removeFileIfPresent(draftPath)
    try {
      if ((await lstat(ownerPath)).nlink === 1) {
        await unlink(ownerPath)
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        console.warn('[agent-hooks] Failed to clean managed-hook owner file', error)
      }
    }
  }
}

async function cleanOwnerEntry(path: string, token: string, hostIdentity: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.nlink !== 1) {
    return
  }
  const owner = parseOwner(await readFile(path, 'utf8'), token)
  if (!owner || owner.hostIdentity !== hostIdentity) {
    return
  }
  const currentIdentity = await readManagedHookProcessIdentity(owner.pid)
  if (
    currentIdentity === null ||
    (typeof currentIdentity === 'string' && currentIdentity !== owner.processIdentity)
  ) {
    await unlink(path)
  }
}

async function cleanLockEntry(
  entry: string,
  lockParent: string,
  hostIdentity: string
): Promise<void> {
  const path = join(lockParent, entry)
  const ownerToken = OWNER_FILE_PATTERN.exec(entry)?.[1] ?? OWNER_DRAFT_PATTERN.exec(entry)?.[1]
  if (ownerToken) {
    await cleanOwnerEntry(path, ownerToken, hostIdentity)
    return
  }
  const claimedMatch = CLAIMED_OWNER_PATTERN.exec(entry)
  if (claimedMatch?.[1] && claimedMatch[2] && (await lstat(path)).nlink === 1) {
    await unlink(path)
    await removeFileIfPresent(
      join(lockParent, claimRecordFileName(claimedMatch[1], claimedMatch[2]))
    )
    return
  }
  const claimMatch = CLAIM_RECORD_PATTERN.exec(entry)
  if (!claimMatch?.[1] || !claimMatch[2]) {
    return
  }
  const claim = parseClaim(await readFile(path, 'utf8'), claimMatch[1], claimMatch[2])
  if (!claim || claim.hostIdentity !== hostIdentity) {
    return
  }
  try {
    await lstat(join(lockParent, claimedOwnerFileName(claim.ownerToken, claim.claimToken)))
    return
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error
    }
  }
  const currentIdentity = await readManagedHookProcessIdentity(claim.pid)
  if (
    currentIdentity === null ||
    (typeof currentIdentity === 'string' && currentIdentity !== claim.processIdentity)
  ) {
    await unlink(path)
  }
}

export async function cleanupManagedHookLockFiles(
  lockParent: string,
  hostIdentity: string
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(lockParent)
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await cleanLockEntry(entry, lockParent, hostIdentity)
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) {
          console.warn('[agent-hooks] Failed to clean managed-hook lock file', error)
        }
      }
    })
  )
}
