import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { removeManagedHookLock } from './managed-hook-lock-claims'
import {
  cleanupManagedHookLockFiles,
  deactivateManagedHookLockOwner,
  inspectManagedHookLock,
  isManagedHookLockOwnerActive,
  tryCreateManagedHookLock,
  type ManagedHookLockOwner
} from './managed-hook-lock-records'
import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity
} from './managed-hook-owner-identity'

const LOCK_WAIT_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 20

async function releaseInstallLock(
  lockPath: string,
  lockParent: string,
  owner: ManagedHookLockOwner,
  hostIdentity: string,
  processIdentity: string
): Promise<void> {
  try {
    const removal = await removeManagedHookLock(
      lockPath,
      lockParent,
      owner,
      hostIdentity,
      processIdentity
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
  suppliedHostIdentity?: string
): Promise<() => Promise<void>> {
  const lockParent = join(home, '.orca')
  const lockPath = join(lockParent, 'managed-hook-install.lock')
  await mkdir(lockParent, { recursive: true })
  const hostIdentity = suppliedHostIdentity ?? (await readManagedHookHostIdentity())
  await cleanupManagedHookLockFiles(lockParent, hostIdentity)
  const processIdentity = await readManagedHookProcessIdentity(process.pid)
  if (typeof processIdentity !== 'string') {
    throw new Error('Could not identify the managed-hook installer process')
  }
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS

  while (true) {
    signal?.throwIfAborted()
    const owner = await tryCreateManagedHookLock(
      lockParent,
      lockPath,
      hostIdentity,
      processIdentity
    )
    if (owner) {
      return async () =>
        await releaseInstallLock(lockPath, lockParent, owner, hostIdentity, processIdentity)
    }

    const state = await inspectManagedHookLock(lockPath)
    if (state.kind === 'unknown') {
      // Why: unverifiable legacy locks cannot be stolen safely; hooks are best-effort,
      // so fail fast instead of adding a recurring connection timeout.
      throw new Error('Managed-hook install lock has an unverifiable owner')
    }
    if (state.kind === 'owned' && state.owner.hostIdentity !== hostIdentity) {
      // Why: homes can be shared across SSH hosts, whose PID namespaces are unrelated.
      throw new Error('Managed-hook install lock belongs to another host')
    }

    if (state.kind === 'owned') {
      const currentIdentity = await readManagedHookProcessIdentity(state.owner.pid)
      if (currentIdentity === undefined) {
        throw new Error('Could not verify the managed-hook lock owner process')
      }
      const abandonedOwnLock =
        state.owner.pid === process.pid &&
        currentIdentity === processIdentity &&
        !isManagedHookLockOwnerActive(state.owner.token)
      if (
        currentIdentity === null ||
        currentIdentity !== state.owner.processIdentity ||
        abandonedOwnLock
      ) {
        const removal = await removeManagedHookLock(
          lockPath,
          lockParent,
          state.owner,
          hostIdentity,
          processIdentity
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
  hostIdentity?: string
): Promise<T> {
  const release = await acquireInstallLock(home, signal, hostIdentity)
  try {
    signal?.throwIfAborted()
    return await run()
  } finally {
    await release()
  }
}
