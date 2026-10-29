import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

export const BROWSER_HOST_CLIENT_IDENTITY_FILE_NAME = 'browser-host-client-identity.json'

const IDENTITY_STORE_VERSION = 1
// Match the wire limit even when the stored value is corrupt.
const MAX_IDENTITY_LENGTH = 256

export function browserHostClientIdentityPath(profileDirectory: string): string {
  return join(profileDirectory, BROWSER_HOST_CLIENT_IDENTITY_FILE_NAME)
}

/** Persist the host ID so relaunches do not fence existing leases and drop their pages. */
export function readOrCreateBrowserHostClientId(profileDirectory: string): string {
  const filePath = browserHostClientIdentityPath(profileDirectory)
  const stored = readStoredBrowserHostClientId(filePath)
  if (stored) {
    return stored
  }
  const minted = randomUUID()
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileDurableSync(
      durableWriteTempPath(filePath),
      filePath,
      `${JSON.stringify({ version: IDENTITY_STORE_VERSION, browserHostClientId: minted })}\n`
    )
  } catch (error) {
    // An unwritable profile can still host pages with an ephemeral ID.
    console.warn('[browser-client-host] could not persist the hosting identity:', error)
  }
  return minted
}

function readStoredBrowserHostClientId(filePath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== IDENTITY_STORE_VERSION
    ) {
      return null
    }
    const identity = (parsed as { browserHostClientId?: unknown }).browserHostClientId
    return typeof identity === 'string' &&
      identity.length > 0 &&
      identity.length <= MAX_IDENTITY_LENGTH
      ? identity
      : null
  } catch {
    return null
  }
}
