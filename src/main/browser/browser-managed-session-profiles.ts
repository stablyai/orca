import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import {
  isManagedBrowserProfileOf,
  managedBrowserProfileOwnerKey,
  type ManagedBrowserProfileOwner
} from '../../shared/browser-profile-scope'
import { InFlightPromiseDedupe } from '../../shared/in-flight-promise-dedupe'
import { browserSessionRegistry } from './browser-session-registry'

const creations = new InFlightPromiseDedupe<BrowserSessionProfile | null>()

function findManagedProfile(owner: ManagedBrowserProfileOwner): BrowserSessionProfile | undefined {
  return browserSessionRegistry
    .listProfiles()
    .find((profile) => isManagedBrowserProfileOf(profile, owner))
}

/** A repo's or workspace's own profile, created on first use; concurrent callers share one creation. */
export async function ensureManagedBrowserProfile(
  owner: ManagedBrowserProfileOwner,
  label: string
): Promise<BrowserSessionProfile | null> {
  // Why: this is an IPC boundary, so the renderer's values are checked before they are persisted.
  if (
    (owner?.kind !== 'repo' && owner?.kind !== 'worktree') ||
    typeof owner.id !== 'string' ||
    typeof label !== 'string'
  ) {
    throw new Error('Invalid managed browser profile owner')
  }
  const { kind, id } = owner
  return (
    findManagedProfile(owner) ??
    creations.run(managedBrowserProfileOwnerKey(owner), () =>
      browserSessionRegistry.createProfile('isolated', label, { kind, id })
    )
  )
}

export function deleteManagedBrowserProfile(owner: ManagedBrowserProfileOwner): Promise<boolean> {
  const profile = findManagedProfile(owner)
  return profile ? browserSessionRegistry.deleteProfile(profile.id) : Promise.resolve(false)
}
