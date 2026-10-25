import type { ManagedBrowserProfileOwner } from '../../../shared/browser-profile-scope'

type ManagedBrowserProfileDeleter = (owner: ManagedBrowserProfileOwner) => unknown

let deleteProfile: ManagedBrowserProfileDeleter | null = null

export function setManagedBrowserProfileDeleter(deleter: ManagedBrowserProfileDeleter): void {
  deleteProfile = deleter
}

export function deleteRemovedOwnerBrowserProfile(owner: ManagedBrowserProfileOwner): void {
  deleteProfile?.(owner)
}
