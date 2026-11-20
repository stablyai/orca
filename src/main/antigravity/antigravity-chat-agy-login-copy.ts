// Where agy keeps its login in a file (SSH, WSL, containers, Linux without a session bus), it reads
// it from the app data folder it runs with: `<home>/antigravity-acp/antigravity-oauth-token` on
// Orca's chat home, never agy's own `~/.gemini/antigravity-cli/…`. A copy, refreshed at each chat
// start, makes the login a person signs in with by running `agy` serve Orca's chat home too. Not a
// link: agy rewrites the file in place on refresh, and through a link a running chat would write
// its login back into `~/.gemini`, undoing a logout or an account switch.

import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'

const TOKEN_FILE = 'antigravity-oauth-token'

/** Keeps Orca's chat home holding a private copy of agy's own login file for Google, and none for
 *  a key or gcloud, which mustn't find one, nor once agy has no login (signed out). Orca's server
 *  never wrote this file, so whatever is there is Orca's copy, or an earlier build's link. Keyring
 *  hosts have no login file and share the OS login. Never fails the launch. */
export async function copyAgyLoginIntoChatHome(
  chatHome: string,
  userHome: string,
  google: boolean
): Promise<void> {
  const file = join(chatHome, ANTIGRAVITY_ACP_HOME, TOKEN_FILE)
  const target = join(userHome, '.gemini', 'antigravity-cli', TOKEN_FILE)
  try {
    const entry = await lstat(file).catch(() => null)
    const login = google ? await readFile(target).catch(() => null) : null
    if (!login) {
      if (entry) {
        await rm(file, { force: true })
      }
      return
    }
    if (entry?.isFile() && (await readFile(file)).equals(login)) {
      await chmod(file, 0o600)
      return
    }
    // Written aside and renamed in, so an agy reading it never sees half a file; a link is replaced.
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, login, { mode: 0o600 })
    await rename(temp, file).catch(async (error: unknown) => {
      await rm(temp, { force: true })
      throw error
    })
  } catch (error) {
    console.warn("[antigravity] agy's login not copied into the chat home:", error)
  }
}
