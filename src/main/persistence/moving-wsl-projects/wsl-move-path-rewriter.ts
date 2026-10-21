/**
 * The path-rewrite stage of a local WSL move: a UNC path of the moved distro becomes the Linux path
 * orcad sees for the same file. Anything else is returned unchanged, as the stage contract requires.
 */
import { wslUncPathToLinux } from '../../../shared/wsl-paths'
import type { OrcadMigrationPathRewriter } from '../../ssh/orcad-migration-path-rewrite'

export function createUncToLinuxPathRewriter(distro: string): OrcadMigrationPathRewriter {
  const fileUrl = new RegExp(`^file://(?:wsl\\.localhost|wsl\\$)/([^/]+)(/.*)?$`, 'i')
  return {
    path: (value, form) => {
      switch (form) {
        case 'absolute':
          return wslUncPathToLinux(value, distro) ?? value
        case 'maybe-absolute':
          return wslUncPathToLinux(value, distro) ?? (isRelative(value) ? toPosix(value) : value)
        case 'relative':
          return toPosix(value)
        case 'url': {
          const match = fileUrl.exec(value)
          return match && decodeSegment(match[1]).toLowerCase() === distro.toLowerCase()
            ? `file://${match[2] ?? '/'}`
            : value
        }
      }
    }
  }
}

/** Windows built these against a UNC root; the host's own paths use `/`. */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

/** `C:trees` is drive-relative, i.e. on Windows; left as it is. */
function isRelative(value: string): boolean {
  return !/^(?:[A-Za-z]:|[\\/])/.test(value)
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
