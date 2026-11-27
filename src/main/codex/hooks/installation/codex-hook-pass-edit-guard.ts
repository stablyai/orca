import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { readNodeFileSyncWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { runWithConcurrentFileEditGuard } from '../../../filesystem/concurrent-file-edit-guard'

/** Worker-only: the file reads behind the hook pass's concurrent-edit guard. */

function readDigest(filePath: string, maxBytes?: number): string | null | undefined {
  try {
    const content =
      maxBytes === undefined
        ? readFileSync(filePath)
        : readNodeFileSyncWithinLimit(filePath, maxBytes).buffer
    return createHash('sha256').update(content).digest('hex')
  } catch (error) {
    // Unknown read failures stay guarded as unreadable; its own writer reports them.
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/**
 * Guards `paths` from their current bytes for the whole of `run`; see concurrent-file-edit-guard.
 * A file over `maxBytes` counts as unreadable, for callers whose own reads reject it at that size.
 */
export function withHookPassEditGuard<T>(
  paths: readonly string[],
  run: () => T,
  options: { maxBytes?: number } = {}
): { value: T; conflict: string | null } {
  const digestOf = (filePath: string): string | null | undefined =>
    readDigest(filePath, options.maxBytes)
  const seeded: { digest: string | null | undefined; aliases: string[] }[] = []
  for (const filePath of paths) {
    const digest = digestOf(filePath)
    const aliases = [filePath]
    try {
      aliases.push(realpathSync.native(filePath))
    } catch {
      // Absent or unresolvable: the spelled path is the only one written.
    }
    seeded.push({ digest, aliases })
  }
  return runWithConcurrentFileEditGuard(seeded, digestOf, run)
}
