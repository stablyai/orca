import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Mark fallback copies so sync can refresh/remove them without touching user-created resources.
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

function parseCopiedResourceSourcePath(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const sourcePath = 'sourcePath' in parsed ? parsed.sourcePath : null
    return typeof sourcePath === 'string' ? sourcePath : null
  } catch {
    return null
  }
}

function readCopiedResourceSourcePath(managedHomePath: string, entryName: string): string | null {
  try {
    return parseCopiedResourceSourcePath(
      readFileSync(getResourceCopyMarkerPath(managedHomePath, entryName), 'utf-8')
    )
  } catch {
    return null
  }
}

/** The source an Orca fallback copy mirrors; null when the entry is a link or the user's own. */
export async function readCopiedResourceSource(
  managedHomePath: string,
  entryName: string
): Promise<string | null> {
  const text = await readFile(getResourceCopyMarkerPath(managedHomePath, entryName), 'utf-8').catch(
    () => null
  )
  return text === null ? null : parseCopiedResourceSourcePath(text)
}

export function clearCopiedResourceMarker(managedHomePath: string, entryName: string): void {
  // Malformed marker directories must not block resource repair or Codex launch.
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
