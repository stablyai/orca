import { win32 as pathWin32 } from 'node:path'
import {
  foldWslUncPathCaseInsensitiveParts,
  parseWslUncPath,
  toWindowsWslPath
} from '../../shared/wsl-paths'

type ManagedWslCodexHome = {
  runtimeHomePath: string
  linuxHomePath: string
}

const managedHomesByDistro = new Map<string, Map<string, ManagedWslCodexHome>>()

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export function isAbsolutePosixPathWithoutDotSegments(value: string): boolean {
  const segments = value.split('/').slice(1)
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    segments.every((segment) => segment && segment !== '.' && segment !== '..')
  )
}

function isOrcaManagedWslCodexHome(linuxHomePath: string): boolean {
  const segments = linuxHomePath.split('/').filter(Boolean)
  const orcaIndex = segments.findIndex(
    (segment, index) =>
      segment === 'orca' && segments[index - 1] === 'share' && segments[index - 2] === '.local'
  )
  if (orcaIndex === -1) {
    return false
  }
  const tail = segments.slice(orcaIndex + 1)
  return (
    (tail.length === 2 && tail[0] === 'codex-runtime-home' && tail[1] === 'home') ||
    (tail.length === 3 && tail[0] === 'codex-accounts' && Boolean(tail[1]) && tail[2] === 'home')
  )
}

function linuxHomeForRuntimePath(runtimeHomePath: string, distro: string): string | null {
  const wsl = parseWslUncPath(runtimeHomePath)
  if (wsl) {
    return wsl.distro.toLowerCase() === distroKey(distro) ? wsl.linuxPath : null
  }
  const drive = runtimeHomePath.match(/^([A-Za-z]):[/\\](.*)$/)
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}` : null
}

export function recordManagedWslCodexHome(distro: string, runtimeHomePath: string): void {
  const normalizedDistro = distro.trim()
  const linuxHomePath = linuxHomeForRuntimePath(runtimeHomePath, normalizedDistro)
  if (
    !normalizedDistro ||
    /[\\/\r\n]/.test(normalizedDistro) ||
    !linuxHomePath ||
    !isAbsolutePosixPathWithoutDotSegments(linuxHomePath) ||
    !isOrcaManagedWslCodexHome(linuxHomePath)
  ) {
    return
  }
  const homes = managedHomesByDistro.get(distroKey(normalizedDistro)) ?? new Map()
  homes.set(linuxHomePath, { runtimeHomePath, linuxHomePath })
  managedHomesByDistro.set(distroKey(normalizedDistro), homes)
}

export function resolveRecordedManagedWslCodexHome(
  distro: string,
  linuxHomePath: string
): string | null {
  if (
    !distro.trim() ||
    /[\\/\r\n]/.test(distro) ||
    !isAbsolutePosixPathWithoutDotSegments(linuxHomePath)
  ) {
    return null
  }
  return managedHomesByDistro.get(distroKey(distro))?.get(linuxHomePath)?.runtimeHomePath ?? null
}

export function resolveManagedWslCodexHome(distro: string, linuxHomePath: string): string | null {
  if (
    !distro.trim() ||
    /[\\/\r\n]/.test(distro) ||
    !isAbsolutePosixPathWithoutDotSegments(linuxHomePath) ||
    !isOrcaManagedWslCodexHome(linuxHomePath)
  ) {
    return null
  }
  return (
    resolveRecordedManagedWslCodexHome(distro, linuxHomePath) ??
    toWindowsWslPath(linuxHomePath, distro)
  )
}

export function wslRuntimeHomePathsEqual(left: string | undefined, right: string): boolean {
  if (!left) {
    return false
  }
  const leftWsl = foldWslUncPathCaseInsensitiveParts(left)
  const rightWsl = foldWslUncPathCaseInsensitiveParts(right)
  if (leftWsl || rightWsl) {
    return leftWsl !== null && leftWsl === rightWsl
  }
  return pathWin32.normalize(left).toLowerCase() === pathWin32.normalize(right).toLowerCase()
}

export const _internals = {
  clearRecordedManagedWslCodexHomes: () => managedHomesByDistro.clear(),
  isOrcaManagedWslCodexHome
}
