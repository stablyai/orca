import { stat } from 'node:fs/promises'
import { isAbsolute, normalize, win32 } from 'node:path'
import { parseRoutableExecutionHostId } from '../../shared/execution-host'
import type { ShellOpenLocalPathFailureReason } from '../../shared/shell-open-types'
import { resolveWindowsPathAccess } from '../windows-path-access-host'

export async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

export async function validateLocalPathTarget(
  pathValue: string,
  // Why injectable: a WSL host's paths are Windows UNC paths, and only exist on win32.
  pathApi: { normalize: (path: string) => string; isAbsolute: (path: string) => boolean } = {
    normalize,
    isAbsolute
  }
): Promise<{ ok: true; path: string } | { ok: false; reason: 'not-absolute' | 'not-found' }> {
  const normalizedPath = pathApi.normalize(pathValue)
  if (!pathApi.isAbsolute(normalizedPath)) {
    return { ok: false, reason: 'not-absolute' }
  }
  if (!(await pathExists(normalizedPath))) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, path: normalizedPath }
}

// Why: the path's owner decides, never the focused server; an absent owner is refused.
export function isLocallyOwned(ownerHostId: unknown): boolean {
  return (
    typeof ownerHostId === 'string' && parseRoutableExecutionHostId(ownerHostId)?.kind === 'local'
  )
}

/**
 * The path this computer opens for `ownerHostId`: the path itself when local, its
 * `\\wsl.localhost` spelling when a WSL host owns it (D5), refused for every other owner.
 */
export async function resolveOwnedPathTarget(
  pathValue: string,
  ownerHostId: unknown
): Promise<{ ok: true; path: string } | { ok: false; reason: ShellOpenLocalPathFailureReason }> {
  if (isLocallyOwned(ownerHostId)) {
    return validateLocalPathTarget(pathValue)
  }
  const access = resolveWindowsPathAccess(ownerHostId)
  if (!access) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  const windowsPath = access.toWindows(pathValue)
  return windowsPath
    ? validateLocalPathTarget(windowsPath, win32)
    : { ok: false, reason: 'not-absolute' }
}
