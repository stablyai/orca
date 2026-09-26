import { profileStateWriterFailureOutcome } from '../profile-state/profile-state-writer-errors'
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
  const resumeScheduling = () => {
    runtime.writesFrozen = false
    runtime.profileMaintenancePending = false
    runtime.pendingProfileMaintenance = null
    resumePreference()
    scheduleSave(domains.scheduling)
  }
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
        resumeScheduling()
      }
    }
  })
  const recoverable = paused.catch(async (error: unknown) => {
    if (await canResumeFailedMaintenance(runtime, options, error)) {
      resumeScheduling()
    } else {
      runtime.writesFrozen = true
      await runtime.profileStateAuthority?.close?.()
    }
    throw error
  })
  runtime.pendingProfileMaintenance = recoverable.then(() => {})
  void runtime.pendingProfileMaintenance.catch(() => {})
  return recoverable
}

async function canResumeFailedMaintenance(
  runtime: StoreRuntimeState,
  options: ProfileStateMaintenanceOptions,
  error: unknown
): Promise<boolean> {
  try {
    await drainProfileFileWork(runtime)
    if (
      options.flush === false ||
      runtime.writesFrozen ||
      profileStateWriterFailureOutcome(error) === 'indeterminate'
    ) {
      return false
    }
    const authority = runtime.profileStateAuthority
    if (authority?.asynchronous) {
      authority.assertWritable()
    }
    await (authority?.pauseForMaintenance
      ? (await authority.pauseForMaintenance()).resume()
      : authority?.assertCurrentRevision?.())
    return true
  } catch {
    return false
  }
}

async function pauseProfileState(
  runtime: StoreRuntimeState,
  domains: StoreDomains,
  { signal, flush = true }: ProfileStateMaintenanceOptions
): Promise<ProfileStateMaintenance> {
  const authority = runtime.profileStateAuthority
  signal?.throwIfAborted()
  await drainProfileFileWork(runtime)
  signal?.throwIfAborted()
  if (flush) {
    // Cancel between commands so a dispatched commit retains a known outcome.
    await flushCurrentStateAsync(domains.flushBarriers, {
      requireInitialGenerationDurable: true,
      fullCheckpoint: true
    })
    signal?.throwIfAborted()
    await authority?.writeJsonCompatibilityExportAsync?.(runtime.dataFile)
  }
  signal?.throwIfAborted()
  runtime.writesFrozen = true
  if (!flush) {
    await authority?.close?.()
    return {
      resume: async () => {
        throw new Error('Recovery maintenance requires reloading the profile')
      }
    }
  }
  if (authority?.pauseForMaintenance) {
    return authority.pauseForMaintenance()
  }
  await authority?.close?.()
  throw new Error('Profile authority cannot safely resume from maintenance')
}

async function drainProfileFileWork(runtime: StoreRuntimeState): Promise<void> {
  await drainProfileStateOperations([
    ...runtime.pendingProfileFlushes,
    runtime.staleProfileStateTempCleanup,
    runtime.pendingWrite,
    runtime.pendingSnapshotFileWork,
    runtime.pendingGithubCacheWrite,
    runtime.activeViewPreference.waitForPendingWrite(),
    runtime.profileStateAuthority?.drainBackups?.(
      runtime.profileMaintenancePending || runtime.quitFlushStarted
    )
  ])
}
