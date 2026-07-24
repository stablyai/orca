import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

export const ORCA_MANAGED_PI_EXTENSION_MARKER = '@orca-managed-pi-extension'
export const PI_MANAGED_EXTENSION_OWNERSHIP_MAX_BYTES = 1_024 * 1_024

export function withOrcaManagedPiExtensionMarker(source: string): string {
  return source.includes(ORCA_MANAGED_PI_EXTENSION_MARKER)
    ? source
    : `// ${ORCA_MANAGED_PI_EXTENSION_MARKER}\n${source}`
}

export function isManagedPiExtensionFile(path: string): boolean {
  try {
    return readNodeFileSyncWithinLimit(path, PI_MANAGED_EXTENSION_OWNERSHIP_MAX_BYTES)
      .buffer.toString('utf8')
      .includes(ORCA_MANAGED_PI_EXTENSION_MARKER)
  } catch {
    // Unreadable or oversized files cannot safely be claimed as Orca-owned.
    return false
  }
}
