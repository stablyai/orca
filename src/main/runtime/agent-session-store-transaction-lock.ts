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
export async function withAgentSessionStoreTransactionLock<T>(
  filePath: string,
  apply: () => Promise<T>
): Promise<T> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const release = await lock(filePath, { realpath: false, retries: LOCK_RETRIES })
  try {
    return await apply()
  } finally {
    await release()
  }
}
