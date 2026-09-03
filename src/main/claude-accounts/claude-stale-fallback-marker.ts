import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

const STALE_FALLBACK_MARKER = 'claude-stale-fallback-v1.json'

/**
 * The marker lives beside the account's auth dir, never inside it: that dir is the CLI's own
 * config directory and Orca does not add files to it.
 */
function markerPathFor(managedAuthPath: string): string {
  return join(resolve(managedAuthPath, '..'), STALE_FALLBACK_MARKER)
}

/**
 * Records that this account's same-home `.credentials.json` may still hold a token we have
 * already replaced in the Keychain.
 *
 * Why written *before* the clear is attempted, and why on disk rather than in memory: the
 * guarantee is "refuse the fallback until a clear succeeds, including after a restart". Written
 * after the clear, a crash between the two would leave the spent token in the file with nothing
 * recording that it must not be served. Written first, any crash leaves the marker present and
 * the next start fails closed.
 */
export function markClaudeStaleFallbackPending(managedAuthPath: string): void {
  const path = markerPathFor(managedAuthPath)
  mkdirSync(resolve(managedAuthPath, '..'), { recursive: true })
  writeFileAtomically(path, JSON.stringify({ markedAt: Date.now() }))
}

/** Only after the fallback file is provably gone. */
export function clearClaudeStaleFallbackMark(managedAuthPath: string): void {
  rmSync(markerPathFor(managedAuthPath), { force: true })
}

/**
 * A marker we cannot read counts as present: an unreadable directory must not silently re-enable
 * the fallback the marker exists to suppress.
 */
export function hasClaudeStaleFallbackMark(managedAuthPath: string): boolean {
  try {
    return statSync(markerPathFor(managedAuthPath)).isFile()
  } catch (error) {
    return !isDefinitiveAbsence(error)
  }
}
