import type { ProfileStateMaintenance } from '../loading-store/profile-state-authority'

/** A drained owner's resume can be attempted only once, including a failed attempt. */
export function profileStateMaintenance(resume: () => Promise<void>): ProfileStateMaintenance {
  let consumed = false
  return {
    resume: async () => {
      if (consumed) {
        throw new Error('Profile maintenance resume has already been consumed')
      }
      consumed = true
      await resume()
    }
  }
}
