import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLAIMED_OWNER_PATTERN,
  claimedOwnerFileName,
  claimRecordFileName,
  hasCode,
  inspectManagedHookLock,
  ownerFileName,
  parseClaim,
  parseOwner,
  removeFileIfPresent,
  type ManagedHookLockClaim,
  type ManagedHookLockOwner
} from './managed-hook-lock-records'
import { readManagedHookProcessIdentity } from './managed-hook-owner-identity'

export type ManagedHookLockRemoval = 'removed' | 'active' | 'foreign' | 'unverifiable'

type AcquiredClaim = {
  kind: 'claimed'
  claim: ManagedHookLockClaim
  claimRecordPath: string
  claimedOwnerPath: string
}

type ClaimResult = AcquiredClaim | { kind: 'active' | 'foreign' | 'unverifiable' | 'contended' }

const activeClaimTokens = new Set<string>()

async function findClaimedOwner(
  lockParent: string,
  ownerToken: string
): Promise<{ claimToken: string; path: string } | null | undefined> {
  const matches = (await readdir(lockParent)).flatMap((entry) => {
    const match = CLAIMED_OWNER_PATTERN.exec(entry)
    return match?.[1] === ownerToken && match[2]
      ? [{ claimToken: match[2], path: join(lockParent, entry) }]
      : []
  })
  return matches.length === 1 ? matches[0] : matches.length === 0 ? null : undefined
}

async function resolveClaimSource(
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string
): Promise<
  | { kind: 'ready'; sourcePath: string; priorClaimRecordPath?: string }
  | { kind: 'active' | 'foreign' | 'unverifiable' }
> {
  const ownerPath = join(lockParent, ownerFileName(owner.token))
  try {
    return parseOwner(await readFile(ownerPath, 'utf8'), owner.token)
      ? { kind: 'ready', sourcePath: ownerPath }
      : { kind: 'unverifiable' }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error
    }
  }

  const claimedOwner = await findClaimedOwner(lockParent, owner.token)
  if (claimedOwner === undefined || claimedOwner === null) {
    return { kind: 'unverifiable' }
  }
  const priorClaimRecordPath = join(
    lockParent,
    claimRecordFileName(owner.token, claimedOwner.claimToken)
  )
  let priorClaim: ManagedHookLockClaim | null
  try {
    priorClaim = parseClaim(
      await readFile(priorClaimRecordPath, 'utf8'),
      owner.token,
      claimedOwner.claimToken
    )
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return { kind: 'unverifiable' }
    }
    throw error
  }
  if (!priorClaim) {
    return { kind: 'unverifiable' }
  }
  if (priorClaim.hostIdentity !== hostIdentity) {
    return { kind: 'foreign' }
  }
  const currentIdentity = await readManagedHookProcessIdentity(priorClaim.pid)
  const recoverOwnInactiveClaim =
    priorClaim.pid === process.pid &&
    currentIdentity === processIdentity &&
    !activeClaimTokens.has(priorClaim.claimToken)
  if (currentIdentity === undefined) {
    return { kind: 'unverifiable' }
  }
  if (currentIdentity === priorClaim.processIdentity && !recoverOwnInactiveClaim) {
    return { kind: 'active' }
  }
  return { kind: 'ready', sourcePath: claimedOwner.path, priorClaimRecordPath }
}

async function claimManagedHookLock(
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string
): Promise<ClaimResult> {
  const source = await resolveClaimSource(lockParent, owner, hostIdentity, processIdentity)
  if (source.kind !== 'ready') {
    return source
  }
  const claimToken = randomUUID()
  const claim = {
    ownerToken: owner.token,
    claimToken,
    pid: process.pid,
    hostIdentity,
    processIdentity
  }
  const claimRecordPath = join(lockParent, claimRecordFileName(owner.token, claimToken))
  const claimedOwnerPath = join(lockParent, claimedOwnerFileName(owner.token, claimToken))
  await writeFile(claimRecordPath, JSON.stringify(claim), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  try {
    try {
      // Why: renaming the witness elects one claimant without ever dropping the hard link.
      await rename(source.sourcePath, claimedOwnerPath)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return { kind: 'contended' }
      }
      throw error
    }
    activeClaimTokens.add(claimToken)
    if (source.priorClaimRecordPath) {
      try {
        await removeFileIfPresent(source.priorClaimRecordPath)
      } catch (error) {
        console.warn('[agent-hooks] Failed to clean prior managed-hook claim record', error)
      }
    }
    return { kind: 'claimed', claim, claimRecordPath, claimedOwnerPath }
  } finally {
    if (!activeClaimTokens.has(claimToken)) {
      await removeFileIfPresent(claimRecordPath)
    }
  }
}

async function cleanAcquiredClaim(claimed: AcquiredClaim): Promise<void> {
  await Promise.all([
    removeFileIfPresent(claimed.claimedOwnerPath),
    removeFileIfPresent(claimed.claimRecordPath)
  ])
}

export async function removeManagedHookLock(
  lockPath: string,
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string
): Promise<ManagedHookLockRemoval> {
  const claimed = await claimManagedHookLock(lockParent, owner, hostIdentity, processIdentity)
  if (claimed.kind === 'contended') {
    return 'active'
  }
  if (claimed.kind === 'unverifiable') {
    const state = await inspectManagedHookLock(lockPath)
    if (state.kind === 'missing' || (state.kind === 'owned' && state.owner.token !== owner.token)) {
      return 'removed'
    }
  }
  if (claimed.kind !== 'claimed') {
    return claimed.kind
  }

  let removed = false
  try {
    const state = await inspectManagedHookLock(lockPath)
    if (state.kind === 'unknown') {
      return 'unverifiable'
    }
    if (state.kind === 'missing' || state.owner.token !== owner.token) {
      removed = true
      return 'removed'
    }
    try {
      await unlink(lockPath)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        return 'unverifiable'
      }
    }
    removed = true
    return 'removed'
  } finally {
    activeClaimTokens.delete(claimed.claim.claimToken)
    if (removed) {
      try {
        await cleanAcquiredClaim(claimed)
      } catch (error) {
        // Why: the canonical lock is already gone; residue cleanup must not
        // turn a successful release into a failed installation.
        console.warn('[agent-hooks] Failed to clean managed-hook recovery claim', error)
      }
    }
  }
}
