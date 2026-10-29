import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { lock } from 'proper-lockfile'

const LOCK_RETRIES = {
  retries: 20,
  factor: 1.3,
  minTimeout: 10,
  maxTimeout: 250,
  randomize: true
}

/** Serialize whole-file transactions across Orca processes sharing one execution host. */
export async function withFileTransactionLock<T>(
  filePath: string,
  apply: () => Promise<T>,
  options: { retries?: number } = {}
): Promise<T> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  let compromised: Error | undefined
  const release = await lock(filePath, {
    realpath: false,
    retries: options.retries ?? LOCK_RETRIES,
    // The default rethrows from proper-lockfile's refresh timer, an uncaught main-process exception.
    onCompromised: (error) => {
      compromised = error
    }
  })
  try {
    const result = await apply()
    if (compromised) {
      throw new Error(
        `Lost the lock on ${filePath} during the transaction; this change may or may not be saved, and another process may have changed the file.`,
        { cause: compromised }
      )
    }
    return result
  } finally {
    // A compromised lock is already released and may belong to another process now.
    if (!compromised) {
      await release()
    }
  }
}
