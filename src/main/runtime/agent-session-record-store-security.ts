import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  loadAgentSessionStore,
  type LoadedAgentSessionStore
} from './agent-session-record-store-file'
import { withAgentSessionStoreTransactionLock } from './agent-session-store-transaction-lock'

const OWNER_DIRECTORY_MODE = 0o700
const OWNER_FILE_MODE = 0o600

async function chmodIfPresent(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

export async function hardenAgentSessionStorePermissions(filePath: string): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE })
  await chmod(directory, OWNER_DIRECTORY_MODE)
  await Promise.all([
    chmodIfPresent(filePath, OWNER_FILE_MODE),
    chmodIfPresent(`${filePath}.bak`, OWNER_FILE_MODE)
  ])
}

export async function loadProtectedAgentSessionStore(
  filePath: string,
  hostId: string
): Promise<LoadedAgentSessionStore> {
  return withAgentSessionStoreTransactionLock(filePath, async () => {
    await hardenAgentSessionStorePermissions(filePath)
    return loadAgentSessionStore(filePath, hostId)
  })
}
