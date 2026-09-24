import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { profileStateDatabaseFile } from '../../../shared/profile-state-storage-paths'
import { hasProfileStateDatabaseFiles } from '../profile-state/profile-state-storage-classification'
import type { ProfileStateMaintenance } from './profile-state-authority'
import type { StoreDomains } from './store-domain-composition'
import type { StoreRuntimeState } from './store-runtime-state'
import { drainProfileStateOperations } from './profile-state-flush-lifetime'
import { flushCurrentStateAsync } from './write-flush-barriers'
import { scheduleSave } from './write-scheduling'

export type ProfileStateMaintenanceOptions = {
  signal?: AbortSignal
  /** Recovery must preserve the existing database even when its state cannot be flushed. */
  flush?: boolean
}

export function freezeProfileStateWrites(runtime: StoreRuntimeState): void {
  if (runtime.profileStateAuthority?.asynchronous) {
    throw new Error('Live profile persistence requires an awaited close')
  }
  runtime.writesFrozen = true
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
    runtime.writeTimer = null
  }
  runtime.profileStateAuthority?.close?.()
}

export async function freezeProfileStateWritesAsync(runtime: StoreRuntimeState): Promise<void> {
  runtime.quitFlushStarted = true
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
    runtime.writeTimer = null
  }
  try {
    await drainProfileStateOperations([
      runtime.pendingProfileMaintenance,
      runtime.activeViewPreference.flushAsync(),
      drainProfileFileWork(runtime)
    ])
  } finally {
    runtime.writesFrozen = true
    await runtime.profileStateAuthority?.close?.()
  }
}

/** Stop admission before the first await; only unchanged-source maintenance may resume. */
export function beginProfileStateMaintenance(
  runtime: StoreRuntimeState,
  domains: StoreDomains,
  options: ProfileStateMaintenanceOptions = {}
): Promise<ProfileStateMaintenance> {
  if (runtime.profileMaintenancePending || runtime.quitFlushStarted || runtime.writesFrozen) {
    return Promise.reject(new Error('Profile persistence is already stopped for maintenance'))
  }
  runtime.profileMaintenancePending = true
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
    runtime.writeTimer = null
  }
  const resumePreference = runtime.activeViewPreference.pauseForMaintenance()
  const paused = pauseProfileState(runtime, domains, options).then((authority) => {
    let consumed = false
    return {
      resume: async () => {
        if (consumed || runtime.quitFlushStarted || !runtime.profileMaintenancePending) {
          throw new Error('Profile persistence cannot resume after finalization')
        }
        consumed = true
        await authority.resume()
        if (runtime.quitFlushStarted) {
          await runtime.profileStateAuthority?.close?.()
          throw new Error('Profile persistence finalized during maintenance admission')
        }
        runtime.writesFrozen = false
        runtime.profileMaintenancePending = false
        runtime.pendingProfileMaintenance = null
        resumePreference()
        scheduleSave(domains.scheduling)
      }
    }
  })
  runtime.pendingProfileMaintenance = paused.then(() => {})
  void runtime.pendingProfileMaintenance.catch(() => {})
  return paused
}

async function pauseProfileState(
  runtime: StoreRuntimeState,
  domains: StoreDomains,
  { signal, flush = true }: ProfileStateMaintenanceOptions
): Promise<ProfileStateMaintenance> {
  const authority = runtime.profileStateAuthority
  try {
    if (signal?.aborted) {
      throw new Error('Profile maintenance aborted')
    }
    await drainProfileStateOperations(runtime.pendingProfileFlushes)
    await (flush
      ? flushCurrentStateAsync(domains.flushBarriers, false, signal, true, true, true)
      : drainProfileFileWork(runtime))
    runtime.writesFrozen = true
    if (!flush) {
      await authority?.drainBackups?.()
      await authority?.close?.()
      return {
        resume: async () => {
          throw new Error('Recovery maintenance requires reloading the profile')
        }
      }
    }
    if (authority?.pauseForMaintenance) {
      return await authority.pauseForMaintenance()
    }
    await authority?.drainBackups?.()
    await authority?.close?.()
    if (authority) {
      throw new Error('Profile authority cannot safely resume from maintenance')
    }
    return await pauseJsonProfile(runtime.dataFile)
  } catch (error) {
    try {
      await drainProfileFileWork(runtime)
    } finally {
      runtime.writesFrozen = true
      await authority?.close?.()
    }
    throw error
  }
}

async function drainProfileFileWork(runtime: StoreRuntimeState): Promise<void> {
  await drainProfileStateOperations([
    ...runtime.pendingProfileFlushes,
    runtime.pendingWrite,
    runtime.pendingSnapshotFileWork,
    runtime.pendingGithubCacheWrite,
    runtime.activeViewPreference.waitForPendingWrite()
  ])
}

async function pauseJsonProfile(dataFile: string): Promise<ProfileStateMaintenance> {
  const before = createHash('sha256')
    .update(await readFile(dataFile))
    .digest('hex')
  return {
    resume: async () => {
      const current = createHash('sha256')
        .update(await readFile(dataFile))
        .digest('hex')
      if (
        hasProfileStateDatabaseFiles(profileStateDatabaseFile(dirname(dataFile))) ||
        current !== before
      ) {
        throw new Error('Profile storage changed during maintenance; reload is required')
      }
    }
  }
}
