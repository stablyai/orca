import { stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type { Store } from '../persistence'

/** True when the path exists on this machine's filesystem. */
export async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

/** Normalizes a caller-supplied path, refusing anything not absolute or not present on disk. */
export async function validateLocalPathTarget(
  pathValue: string
): Promise<{ ok: true; path: string } | { ok: false; reason: 'not-absolute' | 'not-found' }> {
  const normalizedPath = normalize(pathValue)
  if (!isAbsolute(normalizedPath)) {
    return { ok: false, reason: 'not-absolute' }
  }
  if (!(await pathExists(normalizedPath))) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, path: normalizedPath }
}

/** True when a remote runtime owns the session, so local-machine shell actions must refuse. */
export function hasActiveRuntime(store: Store): boolean {
  return Boolean(store.getSettings().activeRuntimeEnvironmentId?.trim())
}
