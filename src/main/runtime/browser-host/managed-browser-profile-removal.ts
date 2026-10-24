import type { ManagedBrowserProfileOwner } from '../../../shared/browser-profile-scope'

type ManagedBrowserProfileDeleter = (owner: ManagedBrowserProfileOwner) => unknown

let deleteProfile: ManagedBrowserProfileDeleter | null = null

/** Installed by the host that owns browser profiles; a headless host has none to delete. */
export function setManagedBrowserProfileDeleter(deleter: ManagedBrowserProfileDeleter): void {
  deleteProfile = deleter
}

/** A removed repo or workspace takes its managed browser profile, and the cookies in it, along. */
export function deleteRemovedOwnerBrowserProfile(owner: ManagedBrowserProfileOwner): void {
  deleteProfile?.(owner)
}
