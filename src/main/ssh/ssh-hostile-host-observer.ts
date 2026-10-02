/**
 * How a hostile-host driver inspects the SSH host outside SSH: `docker exec` for container cells,
 * the local filesystem for a loopback Windows host the test runner administers.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** `old` is far older than any real runtime, so GC must collect it; `new` is newer than the live one. */
export type IdleRuntimeAge = 'old' | 'new'

export type HostileHostObserver = {
  /** Newline-separated forbidden-tool invocations; empty when none ran. */
  readForbiddenToolLog: () => Promise<string>
  /** A verified-looking runtime directory that no reference or process holds. */
  plantIdleRuntime: (storeDir: string, name: string, age: IdleRuntimeAge) => Promise<void>
  exists: (path: string) => Promise<boolean>
  isFile: (path: string) => Promise<boolean>
  /** Changes whenever the file is replaced or rewritten. */
  fileStamp: (path: string) => Promise<string>
  fileSha256: (path: string) => Promise<string>
}

const OLD_RUNTIME_TIME = new Date('2000-01-01T00:00:00Z')

/** For a host on this machine; remote paths use `/`, which Node accepts on Windows too. */
export function localHostObserver(forbiddenToolLog: string): HostileHostObserver {
  return {
    readForbiddenToolLog: async () => {
      try {
        return await readFile(forbiddenToolLog, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return ''
        }
        throw error
      }
    },
    plantIdleRuntime: async (storeDir, name, age) => {
      const dir = join(storeDir, name)
      await mkdir(dir, { recursive: true })
      const marker = join(dir, '.verified')
      await writeFile(marker, '')
      if (age === 'old') {
        await utimes(marker, OLD_RUNTIME_TIME, OLD_RUNTIME_TIME)
      }
    },
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false
      ),
    isFile: (path) =>
      stat(path).then(
        (info) => info.isFile(),
        () => false
      ),
    fileStamp: async (path) => {
      const info = await stat(path, { bigint: true })
      return `${info.ino}:${info.mtimeNs}`
    },
    fileSha256: async (path) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
  }
}
