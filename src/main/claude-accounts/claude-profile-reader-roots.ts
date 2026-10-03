import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'

/** This host's profile `<surface>` dirs; empty where no owner is installed (workers, child processes). */
export function claudeProfileSurfaceRoots(surface: 'projects' | 'transcripts'): string[] {
  return (
    getClaudeProfileRoutingAuthority()
      ?.historyRoots(undefined, surface)
      .map((home) => join(home, surface)) ?? []
  )
}

/** Pure, so an isolate without the owner merges the roots its parent resolved. Shared links scan
 *  once; a private tree is visible without granting an arbitrary linked root. */
export function mergeClaudeProfileReaderRoots(
  legacy: string[],
  candidates: readonly string[]
): string[] {
  if (candidates.length === 0) {
    return legacy
  }
  const allowed = new Set(
    candidates.map((path) => {
      if (isWslUncPath(path)) {
        return path
      }
      try {
        return join(realpathSync.native(dirname(path)), basename(path))
      } catch {
        return resolve(path)
      }
    })
  )
  const seen = new Set<string>()
  return [...legacy, ...candidates].filter((path) => {
    let canonical: string
    try {
      // Why verbatim: a host profile never aliases a WSL guest root, and a UNC realpath is a
      // blocking 9P round trip that this process must not make outside the WSL gate.
      canonical = isWslUncPath(path) ? path : realpathSync.native(path)
    } catch {
      canonical = resolve(path)
    }
    if (!legacy.includes(path) && !allowed.has(canonical)) {
      return false
    }
    if (seen.has(canonical)) {
      return false
    }
    seen.add(canonical)
    return true
  })
}

export function claudeProfileReaderRoots(
  legacy: string[],
  surface: 'projects' | 'transcripts'
): string[] {
  return mergeClaudeProfileReaderRoots(legacy, claudeProfileSurfaceRoots(surface))
}

/** The selected profile's home, or undefined for System Default and any unresolvable selection:
 *  a broken Claude account must never take other providers' discovery down with it. */
export function selectedClaudeProfileHome(): string | undefined {
  try {
    return getClaudeProfileRoutingAuthority()?.resolve().profile?.home
  } catch {
    return undefined
  }
}
