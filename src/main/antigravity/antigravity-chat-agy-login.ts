// Where agy keeps its login in a file (SSH, WSL, containers, Linux without a session bus), it reads
// it from the app data folder it runs with: `<home>/antigravity-acp/antigravity-oauth-token` on
// Orca's chat home, never agy's own `~/.gemini/antigravity-cli/…`. A link makes the login a person
// signs in with by running `agy` serve the chats on Orca's chat home too.

import { lstat, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'

const TOKEN_FILE = 'antigravity-oauth-token'

/** Links agy's own login file into Orca's chat home for Google, and drops that link for a key or
 *  gcloud, which don't read it. A login file agy saved there itself is left alone. Keyring hosts
 *  share one login already; Windows keeps it in Credential Manager. Never fails the launch. */
export async function linkAgyLoginIntoChatHome(
  chatHome: string,
  userHome: string,
  google: boolean,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform === 'win32') {
    return
  }
  const link = join(chatHome, ANTIGRAVITY_ACP_HOME, TOKEN_FILE)
  const target = join(userHome, '.gemini', 'antigravity-cli', TOKEN_FILE)
  try {
    const entry = await lstat(link).catch(() => null)
    if (entry && !entry.isSymbolicLink()) {
      return
    }
    if (entry && (!google || resolve(dirname(link), await readlink(link)) !== target)) {
      await unlink(link)
    } else if (entry) {
      return
    }
    if (google) {
      // Dangling until the person first signs agy in; agy then finds the file through it.
      await symlink(target, link)
    }
  } catch (error) {
    console.warn("[antigravity] agy's login not linked into the chat home:", error)
  }
}
