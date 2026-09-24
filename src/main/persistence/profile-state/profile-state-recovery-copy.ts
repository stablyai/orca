import { constants, copyFileSync, linkSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { runProcessSync } from '../../../shared/child-process/run-process'

// Keep process startup overhead off small recovery copies.
const MINIMUM_CLONE_BYTES = 8 * 1024 * 1024
const MAXIMUM_CLONE_FILES = 16

type RecoveryCopy = { source: string; target: string }

/** Copy quiescent recovery artifacts independently; never copy an active WAL database this way. */
export function copyProfileStateRecoveryFile(source: string, target: string): void {
  copyProfileStateRecoveryFiles([{ source, target }])
}

export function copyProfileStateRecoveryFiles(files: readonly RecoveryCopy[]): void {
  const clones: RecoveryCopy[] = []
  const names = new Set<string>()
  for (const file of files) {
    const info = process.platform === 'darwin' ? lstatSync(file.source) : undefined
    const name = basename(file.source)
    if (!info?.isFile() || info.size < MINIMUM_CLONE_BYTES) {
      copyFileSync(file.source, file.target, constants.COPYFILE_EXCL)
    } else if (
      files.length > 1 &&
      (clones.length === MAXIMUM_CLONE_FILES ||
        !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i.test(name) ||
        names.has(name.toLowerCase()))
    ) {
      // cp derives temporary basenames; ambiguous names need their own private directory.
      copyProfileStateRecoveryFile(file.source, file.target)
    } else {
      clones.push(file)
      names.add(name.toLowerCase())
    }
  }
  if (clones.length === 0) {
    return
  }
  const directory = mkdtempSync(join(dirname(clones[0].target), '.orca-recovery-clone-'))
  const temporary = (source: string) =>
    join(directory, clones.length === 1 ? 'copy' : basename(source))
  let cloned = false
  try {
    // Node's clone flag is unsupported on Darwin; cp -c falls back to ordinary copying.
    const result = runProcessSync({
      program: '/bin/cp',
      args: [
        '-c',
        ...clones.map(({ source }) => resolve(source)),
        resolve(clones.length === 1 ? temporary(clones[0].source) : directory)
      ],
      timeoutMs: 30_000 * clones.length,
      maxOutputBytes: 16_384
    })
    if (result.timedOut || result.signal !== null) {
      throw new Error('Profile recovery file copy was interrupted')
    }
    if (result.code === 0) {
      for (const { source, target } of clones) {
        try {
          linkSync(temporary(source), target)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            throw error
          }
          copyFileSync(source, target, constants.COPYFILE_EXCL)
        }
      }
      cloned = true
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  if (!cloned) {
    for (const { source, target } of clones) {
      copyFileSync(source, target, constants.COPYFILE_EXCL)
    }
  }
}
