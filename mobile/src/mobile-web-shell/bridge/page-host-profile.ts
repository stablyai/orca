import type { BridgeInitHost } from './bridge-envelope'

/**
 * The host `init` named, for the page-only modules that cannot be handed it.
 *
 * A module-scoped read and not a context, because its reader is `host-store.web.ts`: a store the
 * app's screens call as a plain async function, from effects that no provider sits above. The entry
 * publishes this once, before it renders anything, so a screen never sees it change.
 */
let profile: BridgeInitHost | null = null

export function publishPageHostProfile(next: BridgeInitHost | null): void {
  profile = next
}

export function readPageHostProfile(): BridgeInitHost | null {
  return profile
}
