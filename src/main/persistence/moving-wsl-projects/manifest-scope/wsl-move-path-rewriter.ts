// Convert only the moved distro's UNC and mapped-drive paths; unrelated paths remain unchanged.
import {
  wslMappedDriveComparisonKeyToLinux,
  wslMappedDriveFileUrlToLinux,
  wslMoveSourcePathToLinux,
  type WslMappedDrive
} from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import type { OrcadMigrationPathRewriter } from '../../migrating-orcad-catalog/path-rewrite/orcad-migration-path-rewrite'

export type UncToLinuxRewriteOptions = {
  /** Told each drive letter a rewrite mapped, so a move journals only the drives it names. */
  onMappedDrive?: (letter: string) => void
  /** The moved roots in Linux form: a folded `w:/…` key takes back their case. */
  linuxRoots?: readonly string[]
}

export function createUncToLinuxPathRewriter(
  distro: string,
  mappedDrives: readonly WslMappedDrive[] = [],
  options: UncToLinuxRewriteOptions = {}
): OrcadMigrationPathRewriter {
  const fileUrl = new RegExp(`^file://(?:wsl\\.localhost|wsl\\$)/([^/]+)(/.*)?$`, 'i')
  const noted = (value: string, mapped: string | null): string | null => {
    const letter = mapped === null ? null : DRIVE_LETTER.exec(value)?.[1]
    if (letter) {
      options.onMappedDrive?.(letter.toUpperCase())
    }
    return mapped
  }
  const toLinux = (value: string): string | null =>
    noted(
      value,
      (options.linuxRoots &&
        wslMappedDriveComparisonKeyToLinux(value, distro, mappedDrives, options.linuxRoots)) ??
        wslMoveSourcePathToLinux(value, distro, mappedDrives)
    )
  return {
    path: (value, form) => {
      switch (form) {
        case 'absolute':
          return toLinux(value) ?? value
        case 'maybe-absolute':
          return toLinux(value) ?? (isRelative(value) ? toPosix(value) : value)
        case 'relative':
          return toPosix(value)
        case 'url': {
          const match = fileUrl.exec(value)
          if (match && decodeSegment(match[1]).toLowerCase() === distro.toLowerCase()) {
            return `file://${match[2] ?? '/'}`
          }
          return noted(value, wslMappedDriveFileUrlToLinux(value, distro, mappedDrives)) ?? value
        }
      }
    }
  }
}

// A drive path (`W:\x`) or drive file URL (`file:///W:/x`); UNC paths name no letter.
const DRIVE_LETTER = /^(?:file:\/\/\/)?([A-Za-z]):[\\/]/i

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
