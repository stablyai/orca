import { randomBytes } from 'node:crypto'
import { chmodSync, linkSync, lstatSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  bestEffortFsyncDirectorySync,
  fsyncFileSync
} from '../../src/shared/secure-storage/secure-file'
import {
  restrictWindowsPathSync,
  writeRestrictedWindowsFile
} from '../../src/shared/secure-storage/secure-path-windows-acl'

export function writeSecureFileNoClobber(targetPath: string, contents: string): boolean {
  const dir = dirname(targetPath)
  const staged = join(dir, `.orca-observer-${randomBytes(16).toString('hex')}.tmp`)
  let linked = false
  try {
    if (process.platform === 'win32') {
      if (!writeRestrictedWindowsFile(staged, contents, true, { ownerOnly: true })) {
        throw new Error('Bearer output could not be secured')
      }
    } else {
      writeFileSync(staged, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      chmodSync(staged, 0o600)
      if ((lstatSync(staged).mode & 0o777) !== 0o600) {
        throw new Error('Bearer output could not be secured')
      }
    }
    fsyncFileSync(staged)
    linkSync(staged, targetPath)
    linked = true
    if (process.platform === 'win32' && !restrictWindowsPathSync(targetPath, false)) {
      throw new Error('Bearer output could not be secured')
    }
    bestEffortFsyncDirectorySync(dir)
    return true
  } catch (error) {
    if (linked) {
      const source = lstatSync(staged, { throwIfNoEntry: false })
      const published = lstatSync(targetPath, { throwIfNoEntry: false })
      if (
        source &&
        published &&
        source.ino !== 0 &&
        source.dev === published.dev &&
        source.ino === published.ino
      ) {
        rmSync(targetPath)
      }
    }
    throw error
  } finally {
    rmSync(staged, { force: true })
  }
}
