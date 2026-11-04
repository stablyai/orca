import type {
  ProfileStateAuthorityInitialState,
  ProfileStatePersistenceAuthority
} from './profile-state-authority'

/** Startup hands the admitted storage object to exactly one consumer. */
export function createProfileStateStartupTransfer<
  Authority extends ProfileStatePersistenceAuthority
>(
  authority: Authority,
  value: Record<string, unknown> | undefined,
  beforeTake?: () => void
): ProfileStateAuthorityInitialState<Authority> {
  let pending: { value: Record<string, unknown> | undefined } | undefined = { value }
  return {
    authority,
    takeParsedState: () => {
      beforeTake?.()
      if (!pending) {
        throw new Error('Profile state startup snapshot has already been consumed')
      }
      const current = pending
      pending = undefined
      return current.value
    }
  }
}
