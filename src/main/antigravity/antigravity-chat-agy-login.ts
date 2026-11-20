// Where agy keeps its login in a file (SSH, WSL, containers, Linux without a session bus), it reads
// it from the app data folder it runs with: `<home>/antigravity-acp/antigravity-oauth-token` on
// Orca's chat home, never agy's own `~/.gemini/antigravity-cli/…`. A link makes the login a person
// signs in with by running `agy` serve the chats on Orca's chat home too. agy 1.5.13 refreshes
// the file in place (open O_TRUNC, no rename), so its writes go through the link to agy's own file.

import {
  copyFile,
  lstat,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'

const TOKEN_FILE = 'antigravity-oauth-token'
/** Where a login file found in the chat home is kept, so nothing a person had is deleted. */
export const REPLACED_TOKEN_FILE = `${TOKEN_FILE}.orca-replaced`

type Entry = 'none' | 'ours' | 'otherLink' | 'file'

async function readEntry(link: string, target: string): Promise<Entry> {
  const entry = await lstat(link).catch(() => null)
  if (!entry) {
    return 'none'
  }
  if (!entry.isSymbolicLink()) {
    return 'file'
  }
  return resolve(dirname(link), await readlink(link)) === target ? 'ours' : 'otherLink'
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([readFile(a), readFile(b)])
  return left.equals(right)
}

/** Windows needs a privilege for file links, so a copy stands in there; it is refreshed at launch. */
async function placeLogin(link: string, target: string, platform: NodeJS.Platform): Promise<void> {
  try {
    await symlink(target, link)
  } catch (error) {
    if (platform !== 'win32') {
      throw error
    }
    await copyFile(target, link)
  }
}

/** Makes agy's own login file the one Orca's chat home reads for Google, and drops Orca's link
 *  for a key or gcloud, which don't read it. Orca never writes a login there itself, so a file in
 *  its place is a stale copy (a future agy writing by rename, or an older run): it is set aside to
 *  `.orca-replaced`, else old chats would stay on an account agy has since left. No link is made
 *  while agy has no login file (keyring hosts share the OS login; a dangling link would let agy
 *  write a login into `~/.gemini`). Never fails the launch. */
export async function linkAgyLoginIntoChatHome(
  chatHome: string,
  userHome: string,
  google: boolean,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const folder = join(chatHome, ANTIGRAVITY_ACP_HOME)
  const link = join(folder, TOKEN_FILE)
  const target = join(userHome, '.gemini', 'antigravity-cli', TOKEN_FILE)
  try {
    const entry = await readEntry(link, target)
    if (!google) {
      if (entry === 'ours' || entry === 'otherLink') {
        await unlink(link)
      }
      return
    }
    const hasLogin = await stat(target).then(
      (found) => found.isFile(),
      () => false
    )
    if (entry === 'ours' && hasLogin) {
      return
    }
    if (entry === 'file' && hasLogin && platform === 'win32' && (await sameContent(link, target))) {
      return
    }
    if (entry === 'ours' || entry === 'otherLink') {
      await unlink(link)
    } else if (entry === 'file') {
      await rename(link, join(folder, REPLACED_TOKEN_FILE))
    }
    if (hasLogin) {
      await placeLogin(link, target, platform)
    }
  } catch (error) {
    console.warn("[antigravity] agy's login not linked into the chat home:", error)
  }
}
