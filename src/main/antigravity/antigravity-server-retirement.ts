// Removes the temp folders Orca's retired Antigravity server left on this host. Its releases and
// the Google tokens it saved stay, so going back to an older Orca still finds them; agy opens the
// server's conversations in place in Orca's chat home.

import { createHash } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

/** The server's data-folder temp root (the one Windows used, #41021) and its sign-in staging:
 *  per-run leftovers no Orca version reads again. */
export function antigravityServerLeftovers(dataDirectory: string): string[] {
  return [
    join(dataDirectory, 'acp-temp'),
    join(dataDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER, 'sign-in')
  ]
}

/** The server's runs moved to a short /tmp folder named by a hash of its data-folder root. It is
 *  removed only from a parent this user owns privately, as the server created it; another user
 *  could have made `/tmp/oacp-<uid>` first. */
export async function antigravityServerShortTemp(
  dataDirectory: string,
  uid: number | undefined = process.getuid?.(),
  base = '/tmp'
): Promise<string | null> {
  if (uid === undefined) {
    return null
  }
  const parent = join(base, `oacp-${uid}`)
  const owner = await lstat(parent).catch(() => null)
  if (!owner?.isDirectory() || owner.uid !== uid || (owner.mode & 0o077) !== 0) {
    return null
  }
  const root = join(dataDirectory, 'acp-temp', 'antigravity')
  return join(parent, createHash('sha256').update(root).digest('hex').slice(0, 8))
}

// A first removal can be a large tree; it waits out startup's own disk work.
const RETIRE_DELAY_MS = 30_000

/** Runs in the background after every launch; whatever is already gone is skipped. */
export function scheduleAntigravityServerRetirement(dataDirectory: string): void {
  setTimeout(() => void retireAntigravityServerLeftovers(dataDirectory), RETIRE_DELAY_MS).unref()
}

export async function retireAntigravityServerLeftovers(dataDirectory: string): Promise<void> {
  const shortTemp = await antigravityServerShortTemp(dataDirectory)
  await Promise.all(
    [...antigravityServerLeftovers(dataDirectory), ...(shortTemp ? [shortTemp] : [])].map((path) =>
      // Windows can briefly hold files a just-exited process unpacked.
      rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        (error: unknown) => {
          console.warn('[antigravity] retired server files not removed:', path, error)
        }
      )
    )
  )
}
