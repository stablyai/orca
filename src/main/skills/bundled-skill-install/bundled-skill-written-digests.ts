import { join } from 'node:path'
import type { BundledSkillObserved } from '../../../shared/bundled-skill-plan'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'

const SHA256_HEX = /^[0-9a-f]{64}$/u

/**
 * Why on the planned host's disk, not in userData: every Orca build on a host (installed app,
 * dev builds, a CLI, a paired server) shares one skills folder but has its own userData. A build
 * reads what the others wrote, so a copy a newer build installed is not mistaken for a user edit.
 */
function writtenDigestPath(homeDirectory: string, name: string, digest: string): string {
  return join(homeDirectory, '.agents', '.orca-skill-digests', name, digest)
}

/** Whether some Orca build on this host installed `SKILL.md` text with this digest. */
export async function wasBundledSkillDigestWritten(
  filesystem: BundledSkillFilesystem,
  homeDirectory: string,
  name: string,
  digest: string
): Promise<boolean> {
  if (!SHA256_HEX.test(digest)) {
    return false
  }
  const stat = await filesystem.stat(writtenDigestPath(homeDirectory, name, digest))
  return stat?.kind === 'directory'
}

/** One empty marker folder per digest: idempotent, append-only, and safe for concurrent builds. */
export async function recordBundledSkillDigestWritten(
  filesystem: BundledSkillFilesystem,
  homeDirectory: string,
  name: string,
  digest: string
): Promise<void> {
  if (!SHA256_HEX.test(digest)) {
    return
  }
  // Best effort: a missing marker only means another build may ask about this copy once.
  await filesystem
    .ensureDirectory(writtenDigestPath(homeDirectory, name, digest))
    .catch(() => undefined)
}

/** An unknown single-file copy whose bytes some Orca build on this host wrote: not a user edit. */
export async function isOtherBuildCopy(
  filesystem: BundledSkillFilesystem,
  destination: { homeDirectory: string },
  source: { name: string },
  observed: BundledSkillObserved
): Promise<boolean> {
  return (
    observed.kind === 'folder' &&
    observed.entries.length === 1 &&
    observed.skillDigest !== null &&
    (await wasBundledSkillDigestWritten(
      filesystem,
      destination.homeDirectory,
      source.name,
      observed.skillDigest
    ))
  )
}
