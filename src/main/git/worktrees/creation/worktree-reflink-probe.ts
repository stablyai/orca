import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'

const reflinkByDevicePair = new Map<string, Promise<boolean>>()

async function probeReflink(source: string, targetDirectory: string): Promise<boolean> {
  const target = join(targetDirectory, `.orca-reflink-probe-${randomUUID()}`)
  try {
    // FICLONE_FORCE fails instead of copying, so success proves the filesystem shares blocks.
    await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  } finally {
    await rm(target, { force: true }).catch(() => {})
  }
}

/**
 * Whether files in the main checkout can be reflinked into `targetDirectory`, probed once per
 * device pair with the main index so hosts without reflink (e.g. ext4) skip all listing work.
 */
export async function canReflinkIntoDirectory(
  repoPath: string,
  targetDirectory: string
): Promise<boolean> {
  const source = join(repoPath, '.git', 'index')
  const [sourceStat, targetStat] = await Promise.all([
    lstat(source).catch(() => null),
    lstat(targetDirectory).catch(() => null)
  ])
  if (!targetStat?.isDirectory()) {
    return false
  }
  // A main checkout whose .git is a file has no local index to probe; the first clone probes.
  if (!sourceStat?.isFile()) {
    return true
  }
  const key = `${sourceStat.dev}:${targetStat.dev}`
  let probe = reflinkByDevicePair.get(key)
  if (!probe) {
    probe = probeReflink(source, targetDirectory)
    reflinkByDevicePair.set(key, probe)
  }
  return probe
}
