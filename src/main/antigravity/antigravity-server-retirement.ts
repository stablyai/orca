// Removes what Orca's retired Antigravity server left on this host, keeping its conversations,
// which agy now opens in place in Orca's chat home.

import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

/** The server's releases (100 MB to 1 GB each), Orca's Google tokens it signed in with, and its
 *  private temp folders, including the data-folder one Windows used (#41021). */
export function antigravityServerLeftovers(
  dataDirectory: string,
  uid: number | undefined = process.getuid?.()
): string[] {
  const home = join(dataDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER)
  const tempRoot = join(dataDirectory, 'acp-temp')
  // The server's runs moved to a short /tmp folder named by a hash of its data-folder root.
  const shortTemp =
    uid === undefined
      ? []
      : [
          join(
            `/tmp/oacp-${uid}`,
            createHash('sha256').update(join(tempRoot, 'antigravity')).digest('hex').slice(0, 8)
          )
        ]
  return [
    join(dataDirectory, 'agent-runtimes', 'antigravity'),
    join(home, ANTIGRAVITY_ACP_HOME, 'acp_token.json'),
    join(home, ANTIGRAVITY_ACP_HOME, 'acp_business_token.json'),
    join(home, 'sign-in'),
    tempRoot,
    ...shortTemp
  ]
}

/** Runs in the background at every launch; whatever is already gone is skipped. */
export async function retireAntigravityServerLeftovers(dataDirectory: string): Promise<void> {
  await Promise.all(
    antigravityServerLeftovers(dataDirectory).map((path) =>
      // Windows can briefly hold files a just-exited process unpacked.
      rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        (error: unknown) => {
          console.warn('[antigravity] retired server files not removed:', path, error)
        }
      )
    )
  )
}
