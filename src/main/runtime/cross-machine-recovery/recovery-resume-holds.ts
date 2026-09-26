import {
  recoveryBindingKeyString,
  type RecoveryBindingKey
} from '../../../shared/cross-machine-recovery-binding-key'

/** Bindings mid-Resume or mid-release: one owner at a time, and replay never re-adds them. */
export type RecoveryResumeHolds = {
  /** Null when another Resume or release already owns the binding. */
  hold(binding: RecoveryBindingKey): (() => void) | null
  isHeld(binding: RecoveryBindingKey): boolean
}

export function createRecoveryResumeHolds(): RecoveryResumeHolds {
  const held = new Set<string>()
  return {
    hold: (binding) => {
      const key = recoveryBindingKeyString(binding)
      if (held.has(key)) {
        return null
      }
      held.add(key)
      return () => {
        held.delete(key)
      }
    },
    isHeld: (binding) => held.has(recoveryBindingKeyString(binding))
  }
}
