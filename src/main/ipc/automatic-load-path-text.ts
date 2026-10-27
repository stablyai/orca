import { basename, sep } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

// Follow the injected path flavor so Windows rules are testable on every host.
function usesWindowsPaths(): boolean {
  return sep === '\\'
}

const WINDOWS_RESERVED_DEVICE_STEM =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])$/i

/** Windows device names remain devices through extensions, trailing spaces/dots and alternate streams. */
export function isWindowsReservedDeviceName(filePath: string): boolean {
  if (!usesWindowsPaths()) {
    return false
  }
  const stem =
    basename(filePath)
      .replace(/[. ]+$/, '')
      .split(/[.:]/)[0] ?? ''
  return WINDOWS_RESERVED_DEVICE_STEM.test(stem.replace(/ +$/, ''))
}

function toBackslashes(filePath: string): string {
  return filePath.replace(/\//g, '\\')
}

/** A Windows device-namespace path (`\\?\`, `\\.\`), which can name devices and shares alike. */
export function isDeviceNamespacePath(filePath: string): boolean {
  return usesWindowsPaths() && /^\\\\[?.]\\/.test(toBackslashes(filePath))
}

/** WSL UNC paths stay on this machine and are excluded from network shares. */
export function isNetworkSharePath(filePath: string): boolean {
  if (!usesWindowsPaths() || isDeviceNamespacePath(filePath)) {
    return false
  }
  const normalized = toBackslashes(filePath)
  return normalized.startsWith('\\\\') && parseWslUncPath(normalized) === null
}
