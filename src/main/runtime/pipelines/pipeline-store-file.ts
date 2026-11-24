import { chmodSync, closeSync, existsSync, lstatSync, openSync } from 'node:fs'

export function preparePipelineStoreFile(file: string): void {
  if (file === ':memory:') {
    return
  }
  if (!existsSync(file)) {
    closeSync(openSync(file, 'wx', 0o600))
  }
  const stat = lstatSync(file)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('pipeline_store_permissions')
  }
}

export function restrictPipelineStoreSidecars(file: string): void {
  if (file !== ':memory:') {
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(file + suffix)) {
        chmodSync(file + suffix, 0o600)
      }
    }
  }
}
