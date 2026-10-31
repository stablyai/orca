import { createHash } from 'node:crypto'

const revisions = new Map<(version: string) => string, string>()

/** The bundle hash alone misses launcher edits; a new guest dir forces one reinstall of launch.sh. */
export function withWslGuestLauncherRevision(
  bundleVersion: string,
  buildLaunchScript: (version: string) => string
): string {
  let revision = revisions.get(buildLaunchScript)
  if (!revision) {
    revision = createHash('sha256').update(buildLaunchScript('0')).digest('hex').slice(0, 8)
    revisions.set(buildLaunchScript, revision)
  }
  return `${bundleVersion}.${revision}`
}
