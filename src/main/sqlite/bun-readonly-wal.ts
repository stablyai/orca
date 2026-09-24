import { closeSync, existsSync, openSync, readSync } from 'node:fs'

/** Match SQLite's WAL creation without permitting writes through the database connection. */
export function initializeBunReadonlyWal(path: string): void {
  const wal = `${path}-wal`
  if (existsSync(wal) || !hasWalHeader(path)) {
    return
  }
  try {
    // Apple's SQLite requires an existing WAL; exclusive creation preserves every existing byte.
    closeSync(openSync(wal, 'wx', 0o600))
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error
    }
  }
}

function hasWalHeader(path: string): boolean {
  const file = openSync(path, 'r')
  try {
    const header = Buffer.alloc(20)
    return (
      readSync(file, header, 0, header.length, 0) === header.length &&
      header.subarray(0, 16).toString() === 'SQLite format 3\0' &&
      header[18] === 2 &&
      header[19] === 2
    )
  } finally {
    closeSync(file)
  }
}
