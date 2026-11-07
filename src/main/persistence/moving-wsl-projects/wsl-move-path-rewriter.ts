// Convert only the moved distro's UNC paths; unrelated paths remain unchanged.
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

// Relative Windows paths need host-side POSIX separators.
function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Drive-relative C:trees stays on Windows. */
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
