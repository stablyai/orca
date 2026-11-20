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
import { waitForCopyTurn } from './codex-legacy-session-copy-turns'

/**
 * Before a resume looks for a copy's name: waits out a swap of it, and gives a copy that a stopped
 * swap left moved aside its name back. Starts no swap.
 */
export async function settleLegacySessionCopyName(args: {
  managedHome: string
  relativePath: string
}): Promise<void> {
  const copyPath = join(args.managedHome, 'sessions', args.relativePath)
  await waitForCopyTurn(copyPath)
  if (await lstatIfPresent(copyPath)) {
    return
  }
  const markerPath = legacySessionCopyMarkerPath(args.managedHome, args.relativePath)
  // Only a marker proven absent lets the caller link the source in over a copy that may be aside.
  const marker = await readFile(markerPath, 'utf-8').then(
    parseLegacyCopiedSessionMarker,
    (error: unknown) => {
      if (isDefinitiveAbsence(error)) {
        return null
      }
      throw error
    }
  )
  if (marker && !marker.kept) {
    await restoreMovedCopy(marker, normalize(marker.sourcePath), copyPath)
  }
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
