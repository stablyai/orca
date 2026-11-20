// Removes what Orca's retired Antigravity server left on this host, keeping its conversations,
// which agy now opens in place in Orca's chat home.

import { createHash } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

/** The server's releases (100 MB to 1 GB each), Orca's Google tokens it signed in with, and its
 *  data-folder temp root, the one Windows used (#41021). */
export function antigravityServerLeftovers(dataDirectory: string): string[] {
  const home = join(dataDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER)
  return [
    join(dataDirectory, 'agent-runtimes', 'antigravity'),
    join(home, ANTIGRAVITY_ACP_HOME, 'acp_token.json'),
    join(home, ANTIGRAVITY_ACP_HOME, 'acp_business_token.json'),
    join(home, 'sign-in'),
    join(dataDirectory, 'acp-temp')
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

/** Runs in the background at every launch; whatever is already gone is skipped. */
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
