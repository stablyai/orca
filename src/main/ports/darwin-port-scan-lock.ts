import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statfsSync
} from 'node:fs'
import type { DarwinPortScanOperation } from './port-scan-command-protocol'

/** The child inherits this open-file description; closing a duplicate never unlocks it. */
export function openDarwinPortScanLock(operation: DarwinPortScanOperation): number | null {
  const uid = process.getuid?.()
  const root = '/private/var/tmp'
  const parent = lstatSync(root)
  const filesystem = statfsSync(root)
  if (
    uid === undefined ||
    !parent.isDirectory() ||
    parent.uid !== 0 ||
    (parent.mode & 0o1000) === 0
  ) {
    throw new Error('Port scan lock storage is unavailable.')
  }
  if (![0x1a, 0x11].includes(filesystem.type)) {
    return null
  }
  const directory = `${root}/orca-port-scan-${uid}`
  mkdirSync(directory, { mode: 0o700, recursive: true })
  const dir = lstatSync(directory)
  if (
    !dir.isDirectory() ||
    dir.uid !== uid ||
    (dir.mode & 0o7777) !== 0o700 ||
    dir.dev !== parent.dev
  ) {
    throw new Error('Port scan lock directory is unsafe.')
  }
  const path = `${directory}/${operation}`
  // Darwin O_EXLOCK is an ABI constant absent from Node's fs.constants.
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20,
    0o600
  )
  try {
    const file = fstatSync(fd)
    const entry = lstatSync(path)
    if (
      !file.isFile() ||
      file.uid !== uid ||
      (file.mode & 0o7777) !== 0o600 ||
      file.nlink !== 1 ||
      file.dev !== dir.dev ||
      entry.dev !== file.dev ||
      entry.ino !== file.ino
    ) {
      throw new Error('Port scan lock file is unsafe.')
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
