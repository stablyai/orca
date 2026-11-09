const busyExtensionIds = new Set<string>()

export class BrowserExtensionBusyError extends Error {
  constructor() {
    super('This extension is already being installed or removed')
  }
}

/** Serializes install, update and uninstall of one extension id. */
export async function withBrowserExtensionLock<T>(
  extensionId: string,
  action: () => Promise<T>
): Promise<T> {
  if (busyExtensionIds.has(extensionId)) {
    throw new BrowserExtensionBusyError()
  }
  busyExtensionIds.add(extensionId)
  try {
    return await action()
  } finally {
    busyExtensionIds.delete(extensionId)
  }
}

export function isBrowserExtensionBusy(extensionId: string): boolean {
  return busyExtensionIds.has(extensionId)
}
