import { join } from 'node:path'
import { captureSshResetProfileIdentity } from './ssh-reset-profile-identity'

export type ProfileLifetimeLockBinding = {
  acquire(path: string): object
  assertCurrent(token: object): void
  release(token: object): void
}

/** Participating-process exclusion only; historical ownership requires separate evidence. */
export function acquireProfileLifetimeLock(profile: string, binding: ProfileLifetimeLockBinding) {
  const identity = captureSshResetProfileIdentity(profile)
  const token = binding.acquire(join(identity.physicalPath, 'profile-lifetime.lock'))
  let released = false
  let releaseUnverifiable = false
  const assertReleaseVerifiable = () => {
    if (releaseUnverifiable) {
      throw new Error('profile_lock_release_unverifiable')
    }
  }
  const assertCurrent = () => {
    assertReleaseVerifiable()
    if (released) {
      throw new Error('profile_lock_released')
    }
    identity.assertCurrent()
    binding.assertCurrent(token)
    identity.assertCurrent()
  }
  try {
    assertCurrent()
  } catch (error) {
    try {
      binding.release(token)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'profile_lock_initialization_failed')
    }
    throw error
  }
  return {
    assertCurrent,
    release(assertResourcesRetired: () => undefined) {
      assertReleaseVerifiable()
      if (released) {
        return
      }
      if (assertResourcesRetired() !== undefined) {
        throw new Error('profile_lock_retirement_must_be_synchronous')
      }
      try {
        binding.release(token)
      } catch (error) {
        releaseUnverifiable = true
        throw error
      }
      released = true
    }
  }
}
