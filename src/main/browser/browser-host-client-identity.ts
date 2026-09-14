import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

export const BROWSER_HOST_CLIENT_IDENTITY_FILE_NAME = 'browser-host-client-identity.json'

const IDENTITY_STORE_VERSION = 1
// The wire caps the id at 256 chars; a UUID is far below it, but a corrupt file must not smuggle
// an oversized value onto every attach.
const MAX_IDENTITY_LENGTH = 256

export function browserHostClientIdentityPath(profileDirectory: string): string {
  return join(profileDirectory, BROWSER_HOST_CLIENT_IDENTITY_FILE_NAME)
}

/**
 * The durable name this Orca profile hosts remote browser pages under.
 *
 * A per-process id made every relaunch look like a brand new host: the server fenced the old
 * lease and dropped the pages it was placing, so client-hosted tabs could not survive a quit.
 * The same reasoning already keeps `authorityRuntimeId` out of the partition identity.
 *
 * Losing the file costs one stale server-side lease until its grace expires, so a corrupt or
 * unwritable store mints a fresh id rather than failing the launch.
 */
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
    // Why: an unwritable profile degrades to today's per-process identity, which still hosts pages.
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
