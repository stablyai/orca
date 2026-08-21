import type { PersistedState } from '../../../shared/persisted-state-types'

/**
 * The Store's live state object, never a copy. Extracted operations read and mutate it in place, so a caller that
 * passes a clone or a spread silently loses every write. The Store stays its sole owner and is the only thing that
 * may hand this reference out.
 */
export type StoreOwnedPersistedState = PersistedState
