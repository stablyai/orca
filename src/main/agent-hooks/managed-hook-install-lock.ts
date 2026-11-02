import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { removeManagedHookLock, scopedWindowsOwnerPolicy } from './managed-hook-lock-claims'
import {
  cleanupManagedHookLockFiles,
  deactivateManagedHookLockOwner,
  inspectManagedHookLock,
  isManagedHookLockOwnerActive,
  tryCreateManagedHookLock
} from './managed-hook-lock-records'
import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity,
  readScopedWindowsSelfIdentity,
  type ManagedHookEvidenceReader,
  type ManagedHookOwnerPolicy
} from './managed-hook-owner-identity'

const LOCK_WAIT_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 20
const scopedPreparation = new Map<string, Promise<string | null | undefined>>()
let scopedProcessIdentity: Promise<string | null | undefined> | undefined

export type ManagedHookLockOwner = {
  token: string
  pid: number
  hostIdentity: string
  processIdentity: string
}

export type ManagedHookLockClaim = Omit<ManagedHookLockOwner, 'token'> & {
  ownerToken: string
  claimToken: string
}

export type AcquiredClaim = {
  kind: 'claimed'
  claim: ManagedHookLockClaim
  claimRecordPath: string
  claimedOwnerPath: string
}

export type ClaimResult =
  | AcquiredClaim
  | { kind: 'active' | 'foreign' | 'unverifiable' | 'contended' }

export async function waitForManagedHookPreparation<T>(
  preparation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return await preparation
  }
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([
      preparation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
        }
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function releaseInstallLock(
  lockPath: string,
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string,
  policy?: ManagedHookOwnerPolicy
): Promise<void> {
  try {
    const removal = await removeManagedHookLock(
      lockPath,
      lockParent,
      owner,
      hostIdentity,
      processIdentity,
      policy
    )
    if (removal !== 'removed') {
      console.warn(`[agent-hooks] Failed to release managed-hook install lock: ${removal}`)
    }
  } catch (error) {
    console.warn('[agent-hooks] Failed to release managed-hook install lock', error)
  } finally {
    deactivateManagedHookLockOwner(owner.token)
  }
}

async function acquireInstallLock(
  home: string,
  signal?: AbortSignal,
  suppliedHostIdentity?: string,
  waitTimeoutMs = LOCK_WAIT_TIMEOUT_MS,
  explicitParent?: string,
  readEvidence?: ManagedHookEvidenceReader
): Promise<() => Promise<void>> {
  const lockParent = explicitParent ?? join(home, '.orca')
  const lockPath = join(lockParent, 'managed-hook-install.lock')
  await mkdir(lockParent, { recursive: true, ...(explicitParent ? { mode: 0o700 } : {}) })
  if (explicitParent && process.platform !== 'win32') {
    await chmod(lockParent, 0o700)
  }
  const hostIdentity = suppliedHostIdentity ?? (await readManagedHookHostIdentity())
  const scopedWindows = !!explicitParent && process.platform === 'win32'
  let preparation = explicitParent ? scopedPreparation.get(lockParent) : undefined
  if (!preparation) {
    if (explicitParent && scopedPreparation.size > 0) {
      throw new Error('Managed-hook scoped preparation is still running')
    }
    const ownerSignal = explicitParent ? AbortSignal.timeout(2000) : undefined
    preparation = (async () => {
      if (scopedWindows) {
        scopedProcessIdentity ??= Promise.resolve(readScopedWindowsSelfIdentity())
        const identity = await scopedProcessIdentity
        if (typeof identity !== 'string') {
          throw new Error('Could not identify the managed-hook installer process')
        }
        await cleanupManagedHookLockFiles(
          lockParent,
          hostIdentity,
          ownerSignal,
          scopedWindowsOwnerPolicy(identity, ownerSignal!)
        )
        return identity
      }
      await cleanupManagedHookLockFiles(lockParent, hostIdentity, ownerSignal)
      if (!explicitParent) {
        return await readManagedHookProcessIdentity(process.pid)
      }
      scopedProcessIdentity ??= readManagedHookProcessIdentity(process.pid).then(
        (identity) => {
          if (typeof identity !== 'string') {
            scopedProcessIdentity = undefined
          }
          return identity
        },
        (error: unknown) => {
          scopedProcessIdentity = undefined
          throw error
        }
      )
      const identity = await scopedProcessIdentity
      ownerSignal?.throwIfAborted()
      return identity
    })()
    if (explicitParent) {
      scopedPreparation.set(lockParent, preparation)
      void preparation.then(
        () => scopedPreparation.delete(lockParent),
        () => scopedPreparation.delete(lockParent)
      )
    }
  }
  const processIdentity = await waitForManagedHookPreparation(
    preparation,
    explicitParent ? signal : undefined
  )
  if (typeof processIdentity !== 'string') {
    throw new Error('Could not identify the managed-hook installer process')
  }
  const deadline = Date.now() + waitTimeoutMs
  const policy = scopedWindows
    ? scopedWindowsOwnerPolicy(
        processIdentity,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(waitTimeoutMs)])
          : AbortSignal.timeout(waitTimeoutMs),
        readEvidence
      )
    : undefined
  const release = async (owner: ManagedHookLockOwner) =>
    await releaseInstallLock(
      lockPath,
      lockParent,
      owner,
      hostIdentity,
      processIdentity,
      scopedWindows
        ? scopedWindowsOwnerPolicy(processIdentity, AbortSignal.timeout(250), readEvidence)
        : undefined
    )

  while (true) {
    signal?.throwIfAborted()
    policy?.check()
    const owner = await tryCreateManagedHookLock(
      lockParent,
      lockPath,
      hostIdentity,
      processIdentity
    )
    if (owner) {
      if (policy && (signal?.aborted || Date.now() >= deadline)) {
        await release(owner)
        signal?.throwIfAborted()
        throw new Error('Timed out waiting for another managed-hook install to finish')
      }
      return async () => await release(owner)
    }

    const state = await inspectManagedHookLock(lockPath)
    if (state.kind === 'unknown') {
      // Never steal unverifiable legacy locks; fail fast rather than delay best-effort installation.
      throw new Error('Managed-hook install lock has an unverifiable owner')
    }
    if (state.kind === 'owned' && state.owner.hostIdentity !== hostIdentity) {
      // Shared homes can span unrelated host PID namespaces.
      throw new Error('Managed-hook install lock belongs to another host')
    }

    if (state.kind === 'owned') {
      let ended: boolean
      if (policy) {
        const lifecycle = await policy.observe(
          state.owner,
          state.owner.token,
          isManagedHookLockOwnerActive(state.owner.token),
          true
        )
        if (lifecycle === 'unknown') {
          throw new Error('Could not verify the managed-hook lock owner process')
        }
        ended = lifecycle === 'ended'
      } else {
        const currentIdentity = await readManagedHookProcessIdentity(state.owner.pid)
        if (currentIdentity === undefined) {
          throw new Error('Could not verify the managed-hook lock owner process')
        }
        const abandonedOwnLock =
          state.owner.pid === process.pid &&
          currentIdentity === processIdentity &&
          !isManagedHookLockOwnerActive(state.owner.token)
        ended =
          currentIdentity === null ||
          currentIdentity !== state.owner.processIdentity ||
          abandonedOwnLock
      }
      if (ended) {
        const removal = await removeManagedHookLock(
          lockPath,
          lockParent,
          state.owner,
          hostIdentity,
          processIdentity,
          policy,
          policy
            ? () => {
                policy.check()
                if (Date.now() >= deadline) {
                  throw new Error('Timed out waiting for another managed-hook install to finish')
                }
              }
            : undefined
        )
        if (removal === 'removed') {
          if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for another managed-hook install to finish')
          }
          continue
        }
        if (removal === 'foreign') {
          throw new Error('Managed-hook install lock recovery belongs to another host')
        }
        if (removal === 'unverifiable') {
          throw new Error('Managed-hook install lock has an unverifiable recovery claim')
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for another managed-hook install to finish')
    }
    await delay(LOCK_RETRY_MS, undefined, { signal })
  }
}

/** Serialize config merges across relay daemons that target the same account. */
export async function withManagedHookInstallLock<T>(
  home: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  hostIdentity?: string,
  options?: {
    waitTimeoutMs?: number
    lockParent?: string
    readEvidence?: ManagedHookEvidenceReader
  }
): Promise<T> {
  const release = await acquireInstallLock(
    home,
    signal,
    hostIdentity,
    options?.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS,
    options?.lockParent,
    options?.readEvidence
  )
  try {
    signal?.throwIfAborted()
    return await run()
  } finally {
    await release()
  }
}
