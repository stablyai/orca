import { constants, copyFileSync, linkSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from '../../../shared/child-process/run-process'

// Keep process startup overhead off small recovery copies.
const MINIMUM_CLONE_BYTES = 8 * 1024 * 1024

/** Copy quiescent recovery artifacts independently; never copy an active WAL database this way. */
export function copyProfileStateRecoveryFile(source: string, target: string): void {
  const sourceInfo = process.platform === 'darwin' ? lstatSync(source) : undefined
  if (!sourceInfo?.isFile() || sourceInfo.size < MINIMUM_CLONE_BYTES) {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
    return
  }

  // Node's clone flag is unsupported on Darwin; cp -c uses APFS clones with ordinary-copy fallback.
  const directory = mkdtempSync(join(dirname(target), '.orca-recovery-clone-'))
  const temporary = resolve(directory, 'copy')
  let copied = false
  try {
    const result = runProcessSync({
      program: '/bin/cp',
      args: ['-c', resolve(source), temporary],
      timeoutMs: 30_000,
      maxOutputBytes: 16_384
    })
    if (result.timedOut || result.signal !== null) {
      throw new Error('Profile recovery file copy was interrupted')
    }
    if (result.code === 0) {
      // Publish the independent clone without replacing a concurrently created destination.
      try {
        linkSync(temporary, target)
        copied = true
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          throw error
        }
        // Some destination filesystems support copying but not hardlink publication.
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  if (!copied) {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  }
}
