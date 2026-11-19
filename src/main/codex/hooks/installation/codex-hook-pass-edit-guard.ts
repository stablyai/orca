import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { runWithConcurrentFileEditGuard } from '../../../filesystem/concurrent-file-edit-guard'

/** Worker-only: the file reads behind the hook pass's concurrent-edit guard. */

function readDigest(filePath: string): string | null | undefined {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch (error) {
    // Unknown read failures stay guarded as unreadable; its own writer reports them.
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/** Guards `paths` from their current bytes for the whole of `run`; see concurrent-file-edit-guard. */
export function withHookPassEditGuard<T>(
  paths: readonly string[],
  run: () => T
): { value: T; conflict: string | null } {
  const seeded: { digest: string | null | undefined; aliases: string[] }[] = []
  for (const filePath of paths) {
    const digest = readDigest(filePath)
    const aliases = [filePath]
    try {
      aliases.push(realpathSync.native(filePath))
    } catch {
      // Absent or unresolvable: the spelled path is the only one written.
    }
    seeded.push({ digest, aliases })
  }
  return runWithConcurrentFileEditGuard(seeded, readDigest, run)
}
