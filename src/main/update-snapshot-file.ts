import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { restrictWindowsDirectory } from '../shared/secure-path-windows-acl'

export async function snapshotFileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function createPrivateSnapshotDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 })
  if (process.platform === 'win32' && !(await restrictWindowsDirectory(path))) {
    throw new Error('Could not protect the update backup directory')
  }
}
