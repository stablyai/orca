import { readFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'
import {
  legacySessionCopyMarkerPath,
  parseLegacyCopiedSessionMarker,
  type LegacyCopiedSessionMarker
} from './codex-legacy-session-copy-marker'
import { linkUnlessTaken, lstatIfPresent } from './codex-legacy-session-copy-name-ops'
import { runAloneForCopy } from './codex-legacy-session-copy-turns'
import { hasMovedAsideCopy } from './codex-legacy-session-copy-asides'

/**
 * Before a resume looks for a copy's name: runs after any swap of it, and gives a copy that a
 * stopped swap left moved aside its name back. Starts no swap. Throws unless the marker is read or
 * proven absent: only then may the caller link the source in over a copy that may be aside.
 */
export async function settleLegacySessionCopyName(args: {
  managedHome: string
  relativePath: string
}): Promise<void> {
  const copyPath = join(args.managedHome, 'sessions', args.relativePath)
  const settled = await runAloneForCopy(copyPath, 'settle', () => settle(args, copyPath))
  if (settled === 'deferred') {
    throw new Error(`Legacy session copy marker unreadable: ${copyPath}`)
  }
}

async function settle(
  args: { managedHome: string; relativePath: string },
  copyPath: string
): Promise<'none'> {
  if (await lstatIfPresent(copyPath)) {
    return 'none'
  }
  const markerPath = legacySessionCopyMarkerPath(args.managedHome, args.relativePath)
  const marker = await readFile(markerPath, 'utf-8').then(
    async (text) => {
      const parsed = parseLegacyCopiedSessionMarker(text)
      // A marker that can't be parsed may have named a copy that is aside now.
      if (!parsed && (await hasMovedAsideCopy(copyPath))) {
        throw new Error(`Legacy session copy marker malformed: ${markerPath}`)
      }
      return parsed
    },
    async (error: unknown) => {
      // With no copy moved aside there is nothing a marker could give back.
      if (isDefinitiveAbsence(error) || !(await hasMovedAsideCopy(copyPath))) {
        return null
      }
      throw error
    }
  )
  if (marker && !marker.kept) {
    await restoreMovedCopy(marker, normalize(marker.sourcePath), copyPath)
  }
  return 'none'
}

/** A swap stopped after moving the copy aside: its name comes back before anything else. */
export async function restoreMovedCopy(
  marker: LegacyCopiedSessionMarker,
  sourcePath: string,
  copyPath: string
): Promise<'restored' | 'held' | 'none'> {
  const asidePath = marker.aside ? join(dirname(copyPath), marker.aside) : null
  const aside = asidePath ? await lstatIfPresent(asidePath) : null
  // An empty aside is a reservation the copy never moved onto.
  if (!asidePath || !aside?.isFile() || aside.size === 0n) {
    return 'none'
  }
  // Under the deletion guard: a cleanup deleting this chat must not see its name come back.
  return (await linkCodexRolloutUnlessHeld(sourcePath, () =>
    linkUnlessTaken(asidePath, copyPath)
  )) === 'held'
    ? 'held'
    : 'restored'
}
