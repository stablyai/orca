import { readdirSync } from 'fs'
import type { Dirent } from 'fs'
import { homedir, platform } from 'os'
import path from 'path'

const WARP_CHANNELS = [
  { macName: '.warp', linuxName: 'warp-terminal', windowsName: 'Warp' },
  { macName: '.warp-preview', linuxName: 'warp-terminal-preview', windowsName: 'WarpPreview' },
  { macName: '.warp-oss', linuxName: 'warp-oss', windowsName: 'WarpOss' },
  { macName: '.warp-dev', linuxName: 'warp-terminal-dev', windowsName: 'WarpDev' },
  { macName: '.warp-local', linuxName: 'warp-terminal-local', windowsName: 'WarpLocal' },
  {
    macName: '.warp-integration',
    linuxName: 'warp-terminal-integration',
    windowsName: 'WarpIntegration'
  }
]

function readDirectoryEntries(directoryPath: string): Dirent[] {
  try {
    return readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    )
  } catch {
    return []
  }
}

function addDedupeDirectory(
  directories: string[],
  seenDirectories: Set<string>,
  directoryPath: string,
  pathImpl: typeof path.posix
): void {
  const normalizedPath = pathImpl.normalize(pathImpl.resolve(directoryPath))
  if (seenDirectories.has(normalizedPath)) {
    return
  }
  seenDirectories.add(normalizedPath)
  directories.push(directoryPath)
}

function warpThemeDirectoriesFromDataHomes(
  dataHomes: string[],
  pathImpl: typeof path.posix
): string[] {
  const directories: string[] = []
  const seenDirectories = new Set<string>()
  for (const dataHome of dataHomes) {
    addDedupeDirectory(directories, seenDirectories, pathImpl.join(dataHome, 'themes'), pathImpl)
  }
  return directories
}

function getMacWarpThemeDirectories(home: string): string[] {
  const pathImpl = path.posix
  return warpThemeDirectoriesFromDataHomes(
    [
      ...WARP_CHANNELS.map((channel) => pathImpl.join(home, channel.macName)),
      ...readDirectoryEntries(home)
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('.warp'))
        .map((entry) => pathImpl.join(home, entry.name))
    ],
    pathImpl
  )
}

function getLinuxWarpThemeDirectories(home: string): string[] {
  const pathImpl = path.posix
  const xdgDataHome = process.env.XDG_DATA_HOME
  // Why: XDG_DATA_HOME is only valid as an absolute path; relative values would
  // make discovery depend on Orca's launch directory.
  const dataHome =
    xdgDataHome && pathImpl.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : pathImpl.join(home, '.local', 'share')
  return warpThemeDirectoriesFromDataHomes(
    [
      ...WARP_CHANNELS.map((channel) => pathImpl.join(dataHome, channel.linuxName)),
      ...readDirectoryEntries(dataHome)
        .filter(
          (entry) =>
            entry.isDirectory() &&
            (entry.name === 'warp-terminal' || entry.name.startsWith('warp-'))
        )
        .map((entry) => pathImpl.join(dataHome, entry.name))
    ],
    pathImpl
  )
}

function getWindowsWarpThemeDirectories(home: string): string[] {
  const appData = process.env.APPDATA || home
  const warpAppData = path.win32.join(appData, 'warp')
  const directories: string[] = []
  const seenDirectories = new Set<string>()
  for (const channel of WARP_CHANNELS) {
    addDedupeDirectory(
      directories,
      seenDirectories,
      path.win32.join(warpAppData, channel.windowsName, 'data', 'themes'),
      path.win32
    )
  }
  for (const entry of readDirectoryEntries(warpAppData)) {
    if (!entry.isDirectory()) {
      continue
    }
    addDedupeDirectory(
      directories,
      seenDirectories,
      path.win32.join(warpAppData, entry.name, 'data', 'themes'),
      path.win32
    )
  }
  return directories
}

export function getWarpThemeDirectories(): string[] {
  const home = homedir()
  const plat = platform()

  switch (plat) {
    case 'darwin':
      return getMacWarpThemeDirectories(home)
    case 'linux':
      return getLinuxWarpThemeDirectories(home)
    case 'win32':
      return getWindowsWarpThemeDirectories(home)
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'freebsd':
    case 'haiku':
    case 'netbsd':
    case 'openbsd':
    case 'sunos':
      return []
  }
}

export function warpThemeSourceLabelForDirectory(directoryPath: string): string {
  const parts = directoryPath.split(/[\\/]+/).filter(Boolean)
  const themesIndex = parts.findLastIndex((part) => part.toLowerCase() === 'themes')
  if (themesIndex < 0) {
    return parts.at(-1) || 'Warp themes'
  }

  const previousPart = parts[themesIndex - 1]
  const windowsAppPart = parts[themesIndex - 2]
  if (previousPart?.toLowerCase() === 'data' && windowsAppPart) {
    return windowsAppPart
  }
  return previousPart || 'Warp themes'
}
