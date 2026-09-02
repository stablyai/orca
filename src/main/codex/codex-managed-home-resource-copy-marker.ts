import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Ownership markers for system Codex resources a managed home had to copy.
 *
 * Why: symlinking is the normal path, but Windows rejects file symlinks outside
 * developer mode and WSL cannot follow a host-side link. The marker records
 * which source a copy came from, so a later sync can refresh or remove Orca's
 * own copy without ever touching a resource the user created in that home.
 */

function getResourceCopyMarkerPath(managedHomePath: string, entryName: string): string {
  return join(managedHomePath, '.orca-resource-copies', `${entryName}.json`)
}

export function markCopiedResource(
  managedHomePath: string,
  entryName: string,
  sourcePath: string
): void {
  const markerPath = getResourceCopyMarkerPath(managedHomePath, entryName)
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, `${JSON.stringify({ sourcePath }, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function readCopiedResourceSourcePath(managedHomePath: string, entryName: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getResourceCopyMarkerPath(managedHomePath, entryName), 'utf-8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const sourcePath = 'sourcePath' in parsed ? parsed.sourcePath : null
    return typeof sourcePath === 'string' ? sourcePath : null
  } catch {
    return null
  }
}

export function clearCopiedResourceMarker(managedHomePath: string, entryName: string): void {
  // Why: a malformed marker directory must not block Codex launch or prevent
  // an owned resource from being repaired.
  rmSync(getResourceCopyMarkerPath(managedHomePath, entryName), {
    recursive: true,
    force: true
  })
}

export function targetIsOwnedFallbackCopy(
  targetPath: string,
  managedHomePath: string,
  entryName: string,
  sourcePath: string
): boolean {
  if (readCopiedResourceSourcePath(managedHomePath, entryName) !== sourcePath) {
    return false
  }
  try {
    return existsSync(targetPath) && !lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}
