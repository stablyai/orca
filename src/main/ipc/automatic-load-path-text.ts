import { basename, sep } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

// Why the path flavour, not the OS: these are Windows path rules, and tests exercise them with
// path.win32 on any host.
function usesWindowsPaths(): boolean {
  return sep === '\\'
}

const WINDOWS_RESERVED_DEVICE_STEM =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * `NUL.png`, `com1 .jpg`, `Aux.`, `NUL:stream.png` name a Windows device, not a file, whatever the
 * extension or alternate data stream (`:`).
 */
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

/**
 * A network share (`\\host\share`). WSL paths are UNC in form but stay on this machine, so they
 * are not network paths.
 */
export function isNetworkSharePath(filePath: string): boolean {
  if (!usesWindowsPaths() || isDeviceNamespacePath(filePath)) {
    return false
  }
  const normalized = toBackslashes(filePath)
  return normalized.startsWith('\\\\') && parseWslUncPath(normalized) === null
}
