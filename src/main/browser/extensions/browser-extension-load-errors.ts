import { notifyBrowserExtensionListChanged } from './browser-extension-list-changes'

/** The last failed load per profile and extension, shown in Settings until a load succeeds. */

const errors = new Map<string, string>()

function key(profileId: string, extensionId: string): string {
  return `${profileId}\0${extensionId}`
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error)
  // Why: Electron prefixes Orca's internal copy path, which means nothing to the user.
  return message.replace(/^Loading extension at .+? failed with: /, '')
}

export function recordBrowserExtensionLoadFailure(
  profileId: string,
  extensionId: string,
  error: unknown
): void {
  const message = errorMessage(error)
  if (errors.get(key(profileId, extensionId)) !== message) {
    errors.set(key(profileId, extensionId), message)
    notifyBrowserExtensionListChanged()
  }
}

export function clearBrowserExtensionLoadFailure(profileId: string, extensionId: string): void {
  if (errors.delete(key(profileId, extensionId))) {
    notifyBrowserExtensionListChanged()
  }
}

export function getBrowserExtensionLoadFailure(
  profileId: string,
  extensionId: string
): string | null {
  return errors.get(key(profileId, extensionId)) ?? null
}

export function forgetBrowserExtensionLoadFailures(match: {
  profileId?: string
  extensionId?: string
}): void {
  // Deleting the current entry while iterating a Map is safe.
  for (const entry of errors.keys()) {
    const [profileId, extensionId] = entry.split('\0')
    if (
      (match.profileId === undefined || match.profileId === profileId) &&
      (match.extensionId === undefined || match.extensionId === extensionId)
    ) {
      errors.delete(entry)
    }
  }
}
