import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeClaimTokens,
  claimedOwnerFileName,
  claimRecordFileName,
  findClaimedOwner,
  hasCode,
  inspectManagedHookLock,
  ownerFileName,
  parseClaim,
  parseOwner,
  removeFileIfPresent,
  type ManagedHookLockClaim,
  type ManagedHookLockOwner
} from './managed-hook-lock-records'
import type { AcquiredClaim, ClaimResult } from './managed-hook-install-lock'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'
import {
  canonicalBirth,
  readManagedHookProcessIdentity,
  readProcessPresence,
  readWindowsProcessIdentity,
  type ManagedHookLifecycle,
  type ManagedHookOwnerPolicy,
  type ManagedHookEvidenceReader
} from './managed-hook-owner-identity'

export type {
  ManagedHookLifecycle,
  ManagedHookOwnerPolicy,
  ManagedHookEvidenceReader
} from './managed-hook-owner-identity'

export type ManagedHookLockRemoval = 'removed' | 'active' | 'foreign' | 'unverifiable'

/** Compare only compatible incarnation facts; opaque identities never prove PID reuse. */
export function scopedWindowsOwnerPolicy(
  self: string,
  signal: AbortSignal,
  readEvidence?: ManagedHookEvidenceReader
): ManagedHookOwnerPolicy {
  type Observation = {
    token: string
    pid: number
    processIdentity: string
    result?: ManagedHookLifecycle
  }
  let ownerObservation: Observation | undefined
  let claimObservation: Observation | undefined
  const matches = (
    observation: Observation | undefined,
    record: { pid: number; processIdentity: string },
    token: string
  ) =>
    observation?.token === token &&
    observation.pid === record.pid &&
    observation.processIdentity === record.processIdentity
  const check = () => signal.throwIfAborted()
  return {
    check,
    async observe(record, token, active, conflict = false, owner) {
      check()
      const canonical = owner ?? { ...record, token }
      if (!matches(ownerObservation, canonical, canonical.token)) {
        ownerObservation = {
          token: canonical.token,
          pid: canonical.pid,
          processIdentity: canonical.processIdentity
        }
        claimObservation = undefined
      }
      let observed = ownerObservation!
      if (owner) {
        if (!matches(claimObservation, record, token)) {
          claimObservation = { token, pid: record.pid, processIdentity: record.processIdentity }
        }
        observed = claimObservation!
      }
      if (record.pid === process.pid && active) {
        return 'same'
      }
      if (record.pid === process.pid && record.processIdentity === self) {
        return 'ended'
      }
      const saved = canonicalBirth(record.processIdentity, record.pid)
      const current = readWindowsProcessCreationTime(record.pid)
      if (saved !== undefined && current !== null) {
        return current === saved ? 'same' : 'ended'
      }
      if (readProcessPresence(record.pid) === null) {
        return 'ended'
      }
      if (saved === undefined || !conflict || !readEvidence) {
        return 'unknown'
      }
      if (observed.result !== undefined) {
        return observed.result
      }
      const identity = await readEvidence(signal, () => readWindowsProcessIdentity(record.pid))
      check()
      const birth = typeof identity === 'string' ? canonicalBirth(identity, record.pid) : undefined
      let result: ManagedHookLifecycle = 'unknown'
      if (identity === null) {
        result = 'ended'
      } else if (birth !== undefined) {
        result = birth === saved ? 'same' : 'ended'
      }
      observed.result = result
      return result
    }
  }
}

async function resolveClaimSource(
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string,
  policy?: ManagedHookOwnerPolicy
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
  if (policy) {
    const lifecycle = await policy.observe(
      priorClaim,
      priorClaim.claimToken,
      activeClaimTokens.has(priorClaim.claimToken),
      true,
      owner
    )
    if (lifecycle !== 'ended') {
      return { kind: lifecycle === 'same' ? 'active' : 'unverifiable' }
    }
  } else {
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
  }
  return { kind: 'ready', sourcePath: claimedOwner.path, priorClaimRecordPath }
}

async function claimManagedHookLock(
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string,
  policy?: ManagedHookOwnerPolicy,
  beforeClaim?: () => void
): Promise<ClaimResult> {
  const source = await resolveClaimSource(lockParent, owner, hostIdentity, processIdentity, policy)
  if (source.kind !== 'ready') {
    return source
  }
  beforeClaim?.()
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
      // Rename elects one claimant while preserving the hard-link witness.
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
  processIdentity: string,
  policy?: ManagedHookOwnerPolicy,
  beforeClaim?: () => void
): Promise<ManagedHookLockRemoval> {
  const claimed = await claimManagedHookLock(
    lockParent,
    owner,
    hostIdentity,
    processIdentity,
    policy,
    beforeClaim
  )
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
        // Residue cleanup must not turn a completed release into installation failure.
        console.warn('[agent-hooks] Failed to clean managed-hook recovery claim', error)
      }
    }
  }
}
