// Where agy keeps its login in a file (SSH, WSL, containers, Linux without a session bus), it reads
// it from the app data folder it runs with: `<home>/antigravity-acp/antigravity-oauth-token` on an
// Orca home, never agy's own `~/.gemini/antigravity-cli/…`. A copy, refreshed at each chat start,
// lets the login agy signs in with serve Orca's homes too. Not a link: agy rewrites the file in
// place on refresh, and through a link a running chat would write its login back into `~/.gemini`,
// undoing a logout or an account switch.

import { randomUUID } from 'node:crypto'
import { chmod, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'

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

/** Keeps an Orca home holding a private copy of agy's own login file for a Google method, and none
 *  for a key or gcloud, which mustn't find one, nor once agy has no login (signed out). Orca's
 *  server never wrote this file, so whatever is there is Orca's copy. Keyring hosts have no login
 *  file and share the OS login. Never fails the launch. */
export async function copyAgyLoginIntoOrcaHome(
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
