/**
 * R38: whether a finished move's distro is still registered. A rename keeps the GUID, so it is the
 * same distro. A new GUID under the old name is either a reinstall or a re-import of the same
 * files, which the registry cannot tell apart.
 */
import type { WslDistroRegistration } from '../../wsl/wsl-distro-registry-id'
import type { WslMovedDistroVerdict } from './wsl-move-orchestrator-external-transitions'

export function wslMovedDistroVerdict(
  registrations: readonly WslDistroRegistration[] | null,
  distro: string,
  distroGuid?: string
): WslMovedDistroVerdict {
  if (!registrations) {
    return 'unknown'
  }
  const name = distro.trim().toLowerCase()
  const guid = distroGuid?.trim().replace(/[{}]/g, '').toLowerCase()
  const byName = registrations.find((entry) => entry.distro.toLowerCase() === name)
  const byGuid = guid ? registrations.find((entry) => entry.id === guid) : undefined
  if (!byName && !byGuid) {
    return 'gone'
  }
  // A new GUID under the old name is also an export and re-import with the same files; only the
  // host's catalog can tell a wiped distro apart, so until that check exists it proves nothing.
  return byName && guid && !byGuid ? 'unknown' : 'present'
}
