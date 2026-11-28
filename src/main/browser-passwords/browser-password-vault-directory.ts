let profileDirectory: string | null = null

/** Points vaults at the active Orca profile, beside its browser-session metadata. */
export function configureBrowserPasswordVaults(directory: string): void {
  profileDirectory = directory
}

export function getBrowserPasswordVaultProfileDirectory(): string | null {
  return profileDirectory
}
