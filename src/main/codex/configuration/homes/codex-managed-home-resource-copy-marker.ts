import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Mark fallback copies so sync can refresh/remove them without touching user-created resources.
function getResourceCopyMarkerPath(managedHomePath: string, entryName: string): string {
  return join(managedHomePath, '.orca-resource-copies', `${entryName}.json`)
}

/** Every name, link and byte under a copy, so a later edit, addition or removal shows. */
function fingerprintCopiedResource(path: string): string {
  const hash = createHash('sha256')
  const visit = (current: string, relative: string): void => {
    const entry = lstatSync(current)
    if (entry.isSymbolicLink()) {
      hash.update(`l\0${relative}\0${readlinkSync(current)}\0`)
    } else if (entry.isDirectory()) {
      hash.update(`d\0${relative}\0`)
      for (const name of readdirSync(current).sort()) {
        visit(join(current, name), `${relative}/${name}`)
      }
    } else {
      hash.update(`f\0${relative}\0`).update(readFileSync(current)).update('\0')
    }
  }
  visit(path, '')
  return hash.digest('hex')
}

export function markCopiedResource(
  managedHomePath: string,
  entryName: string,
  sourcePath: string
): void {
  const markerPath = getResourceCopyMarkerPath(managedHomePath, entryName)
  mkdirSync(dirname(markerPath), { recursive: true })
  const fingerprint = fingerprintCopiedResource(join(managedHomePath, entryName))
  writeFileSync(markerPath, `${JSON.stringify({ sourcePath, fingerprint }, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
}

type CopiedResourceMarker = { sourcePath: string; fingerprint: string | null }

function parseCopiedResourceMarker(text: string): CopiedResourceMarker | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const sourcePath = 'sourcePath' in parsed ? parsed.sourcePath : null
    const fingerprint = 'fingerprint' in parsed ? parsed.fingerprint : null
    return typeof sourcePath === 'string'
      ? { sourcePath, fingerprint: typeof fingerprint === 'string' ? fingerprint : null }
      : null
  } catch {
    return null
  }
}

function parseCopiedResourceSourcePath(text: string): string | null {
  return parseCopiedResourceMarker(text)?.sourcePath ?? null
}

function readCopiedResourceMarker(
  managedHomePath: string,
  entryName: string
): CopiedResourceMarker | null {
  try {
    return parseCopiedResourceMarker(
      readFileSync(getResourceCopyMarkerPath(managedHomePath, entryName), 'utf-8')
    )
  } catch {
    return null
  }
}

function readCopiedResourceSourcePath(managedHomePath: string, entryName: string): string | null {
  return readCopiedResourceMarker(managedHomePath, entryName)?.sourcePath ?? null
}

/**
 * What an owned fallback copy holds against what Orca copied: `current` (and so is its source),
 * `copied` (untouched, source moved on), `changed` (Codex or the user wrote into it, or it predates
 * fingerprints), or `indeterminate` when it can't be read.
 */
export type CopiedResourceState = 'current' | 'copied' | 'changed' | 'indeterminate'

export function inspectCopiedResource(
  targetPath: string,
  sourcePath: string | null,
  managedHomePath: string,
  entryName: string
): CopiedResourceState {
  const fingerprint = readCopiedResourceMarker(managedHomePath, entryName)?.fingerprint
  if (!fingerprint) {
    return 'changed'
  }
  try {
    if (fingerprintCopiedResource(targetPath) !== fingerprint) {
      return 'changed'
    }
  } catch {
    return 'indeterminate'
  }
  try {
    return sourcePath && fingerprintCopiedResource(realpathSync(sourcePath)) === fingerprint
      ? 'current'
      : 'copied'
  } catch {
    return 'copied'
  }
}

/** Removes an untouched copy; a changed one moves aside to `<entry>.orca-kept-<id>` instead. */
export function removeCopiedResource(
  targetPath: string,
  entryName: string,
  state: Exclude<CopiedResourceState, 'indeterminate'>
): void {
  if (state !== 'changed') {
    rmSync(targetPath, { recursive: true, force: true })
    return
  }
  const keptPath = `${targetPath}.orca-kept-${randomUUID()}`
  renameSync(targetPath, keptPath)
  console.warn('[codex-home] Kept a changed copy of', entryName, 'at', keptPath)
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
