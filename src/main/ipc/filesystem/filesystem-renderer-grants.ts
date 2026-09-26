import { isAbsolute, parse, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { isENOENT } from '../filesystem-path-containment'
import { PATH_ACCESS_DENIED_MESSAGE, recordAuthorizedExternalGrant } from '../filesystem-auth'

function canonicalGrantPath(targetPath: string): string {
  const resolvedTarget = resolve(targetPath)
  try {
    return resolve(realpathSync(resolvedTarget))
  } catch {
    return resolvedTarget
  }
}

function isSameResolvedPath(left: string, right: string): boolean {
  if (left === right || relative(left, right) === '') {
    return true
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return false
  }
  const leftKey = left.toLowerCase()
  const rightKey = right.toLowerCase()
  return leftKey === rightKey || relative(leftKey, rightKey) === ''
}

function isDangerousExternalGrantRoot(targetPath: string): boolean {
  const canonicalTarget = canonicalGrantPath(targetPath)
  if (isSameResolvedPath(canonicalTarget, resolve(parse(canonicalTarget).root))) {
    return true
  }
  const home = canonicalGrantPath(homedir())
  if (isSameResolvedPath(canonicalTarget, home)) {
    return true
  }
  return isPathInsideOrEqual(canonicalTarget, home)
}

function resolveRendererGrantPath(targetPath: string): string {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (!isAbsolute(targetPath)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return resolve(targetPath)
}

async function denyRendererGrant(): Promise<never> {
  throw new Error(PATH_ACCESS_DENIED_MESSAGE)
}

export async function grantExternalFileFromRenderer(targetPath: string): Promise<void> {
  const resolvedTarget = resolveRendererGrantPath(targetPath)
  let fileStats
  try {
    fileStats = await lstat(resolvedTarget)
  } catch (error) {
    if (isENOENT(error)) {
      throw new Error(`File not found: ${resolvedTarget}`)
    }
    return denyRendererGrant()
  }
  if (fileStats.isDirectory()) {
    throw new Error(`Cannot open a directory: ${resolvedTarget}`)
  }
  if (isDangerousExternalGrantRoot(resolvedTarget)) {
    return denyRendererGrant()
  }
  let canonicalTarget = resolvedTarget
  try {
    canonicalTarget = resolve(await realpath(resolvedTarget))
  } catch {
    return denyRendererGrant()
  }
  if (isDangerousExternalGrantRoot(canonicalTarget)) {
    return denyRendererGrant()
  }
  if (fileStats.isSymbolicLink()) {
    let followedStats
    try {
      followedStats = await stat(resolvedTarget)
    } catch (error) {
      if (isENOENT(error)) {
        throw new Error(`File not found: ${resolvedTarget}`)
      }
      return denyRendererGrant()
    }
    if (followedStats.isDirectory()) {
      throw new Error(`Cannot open a directory: ${resolvedTarget}`)
    }
  }
  recordAuthorizedExternalGrant(resolvedTarget, canonicalTarget)
}

export async function grantExternalDirectoryFromRenderer(targetPath: string): Promise<void> {
  const resolvedTarget = resolveRendererGrantPath(targetPath)
  let pathStats
  try {
    pathStats = await lstat(resolvedTarget)
  } catch {
    return denyRendererGrant()
  }
  let directoryPath = resolvedTarget
  if (pathStats.isSymbolicLink()) {
    try {
      directoryPath = resolve(await realpath(resolvedTarget))
    } catch {
      return denyRendererGrant()
    }
  } else if (!pathStats.isDirectory()) {
    return denyRendererGrant()
  }
  let directoryStats
  try {
    directoryStats = pathStats.isSymbolicLink() ? await lstat(directoryPath) : pathStats
  } catch {
    return denyRendererGrant()
  }
  let canonicalTarget = directoryPath
  try {
    canonicalTarget = resolve(await realpath(resolvedTarget))
  } catch {
    return denyRendererGrant()
  }
  if (
    !directoryStats.isDirectory() ||
    isDangerousExternalGrantRoot(resolvedTarget) ||
    isDangerousExternalGrantRoot(directoryPath) ||
    isDangerousExternalGrantRoot(canonicalTarget)
  ) {
    return denyRendererGrant()
  }
  recordAuthorizedExternalGrant(resolvedTarget, canonicalTarget)
}
