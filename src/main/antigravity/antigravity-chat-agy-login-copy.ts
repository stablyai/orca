// Where agy keeps its login in a file (SSH, WSL, containers, Linux without a session bus), it reads
// it from the app data folder it runs with: `<home>/antigravity-acp/antigravity-oauth-token` on
// Orca's chat home, never agy's own `~/.gemini/antigravity-cli/…`. A copy, refreshed at each chat
// start, makes the login a person signs in with by running `agy` serve Orca's chat home too. Not a
// link: agy rewrites the file in place on refresh, and through a link a running chat would write
// its login back into `~/.gemini`, undoing a logout or an account switch.

import { randomUUID } from 'node:crypto'
import { chmod, lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import { antigravityChatUsesOrcaHome } from './antigravity-chat-route'
import { antigravityUserHome } from './antigravity-chat-user-skills'

const TOKEN_FILE = 'antigravity-oauth-token'
const TEMP = new RegExp(`^${TOKEN_FILE}\\..+\\.tmp$`)

/** agy's login when it is whole: a file mid-rewrite (agy truncates, then writes) reads as empty or
 *  cut short, and must not replace a good copy. */
function wholeLogin(login: Buffer | null): Buffer | null | 'unreadable' {
  if (login === null) {
    return null
  }
  try {
    JSON.parse(login.toString('utf8'))
    return login
  } catch {
    return 'unreadable'
  }
}

/** Temp files a crash left between write and rename hold the login too. */
async function sweepTemps(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [])
  await Promise.all(
    names.filter((name) => TEMP.test(name)).map((name) => rm(join(folder, name), { force: true }))
  )
}

/** Keeps Orca's chat home holding a private copy of agy's own login file for Google, and none for
 *  a key or gcloud, which mustn't find one, nor once agy has no login (signed out). Orca's server
 *  never wrote this file, so whatever is there is Orca's copy, or an earlier build's link. Keyring
 *  hosts have no login file and share the OS login. Never fails the launch. */
export async function copyAgyLoginIntoChatHome(
  chatHome: string,
  userHome: string,
  google: boolean
): Promise<void> {
  const folder = join(chatHome, ANTIGRAVITY_ACP_HOME)
  const file = join(folder, TOKEN_FILE)
  const target = join(userHome, '.gemini', 'antigravity-cli', TOKEN_FILE)
  try {
    await sweepTemps(folder)
    const entry = await lstat(file).catch(() => null)
    const login = google ? wholeLogin(await readFile(target).catch(() => null)) : null
    if (login === 'unreadable') {
      return
    }
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
    const temp = `${file}.${process.pid}-${randomUUID()}.tmp`
    await writeFile(temp, login, { mode: 0o600 })
    await rename(temp, file).catch(async (error: unknown) => {
      await rm(temp, { force: true })
      throw error
    })
  } catch (error) {
    console.warn("[antigravity] agy's login not copied into the chat home:", error)
  }
}

/** Brings the copy in Orca's chat home in line with agy's login and the saved method outside a
 *  chat start: at launch, after an account switch or removal, and after a method change, so a
 *  signed-out login doesn't wait at rest for the next old-chat resume. Creates no chat home. */
export async function syncAgyLoginCopy(
  savedAuth: unknown,
  dataDirectory: string,
  userHome: string = antigravityUserHome(process.env)
): Promise<void> {
  const chatHome = join(dataDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER)
  if (
    !(await stat(join(chatHome, ANTIGRAVITY_ACP_HOME)).then(
      (found) => found.isDirectory(),
      () => false
    ))
  ) {
    return
  }
  await copyAgyLoginIntoChatHome(chatHome, userHome, !antigravityChatUsesOrcaHome(savedAuth))
}
