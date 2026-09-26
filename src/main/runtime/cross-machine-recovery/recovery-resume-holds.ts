import {
  recoveryBindingKeyString,
  type RecoveryBindingKey
} from '../../../shared/cross-machine-recovery-binding-key'

/** Bindings between their resume claim and launch settling: no record exists, yet the session is not live. */
export type RecoveryResumeHolds = {
  hold(binding: RecoveryBindingKey): () => void
  isHeld(binding: RecoveryBindingKey): boolean
}

export function createRecoveryResumeHolds(): RecoveryResumeHolds {
  const counts = new Map<string, number>()
  return {
    hold: (binding) => {
      const key = recoveryBindingKeyString(binding)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return () => {
        const remaining = (counts.get(key) ?? 0) - 1
        if (remaining > 0) {
          counts.set(key, remaining)
        } else {
          counts.delete(key)
        }
      }
    },
    isHeld: (binding) => counts.has(recoveryBindingKeyString(binding))
  }
}
