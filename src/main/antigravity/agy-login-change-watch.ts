import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { getAntigravityWindowsHome } from './native-windows-credentials'

const SETTLE_MS = 500

let loginRevision = 0
let watchers: FSWatcher[] | null = null
let settle: ReturnType<typeof setTimeout> | null = null

/** Counts the changes seen to agy's stored login, which Settings reads again on each. */
export function agyLoginRevision(): number {
  return loginRevision
}

/** Where agy keeps its login: its token file everywhere, and on macOS the login keychain, whose
 *  database is rewritten when agy stores a new login. The Linux keyring and Windows Credential
 *  Manager have no file to watch, so those hosts re-read on Refresh, a sign-in or a reopen. */
function agyLoginStores(): { dir: string; file: string }[] {
  const home =
    process.platform === 'win32'
      ? getAntigravityWindowsHome(process.env)
      : getAppEnvironment().getPath('home')
  const stores = [
    { dir: join(home, '.gemini', 'antigravity-cli'), file: 'antigravity-oauth-token' }
  ]
  if (process.platform === 'darwin') {
    stores.push({ dir: join(home, 'Library', 'Keychains'), file: 'login.keychain-db' })
  }
  return stores
}

function changed(): void {
  if (settle) {
    clearTimeout(settle)
  }
  settle = setTimeout(() => {
    settle = null
    loginRevision += 1
    // A new revision makes every sign-in subscriber publish, carrying the login revision.
    antigravityChatSignIn.set(antigravityChatSignIn.get().value)
  }, SETTLE_MS)
  settle.unref?.()
}

/** Starts once, when a client first follows agy's sign-in; a store that can't be watched is skipped. */
export function watchAgyLoginChanges(): void {
  if (watchers) {
    return
  }
  watchers = []
  let stores: { dir: string; file: string }[]
  try {
    stores = agyLoginStores()
  } catch {
    return
  }
  for (const { dir, file } of stores) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (!name || name.toString() === file) {
          changed()
        }
      })
      watcher.on('error', () => watcher.close())
      watchers.push(watcher)
    } catch {
      // agy hasn't created this store on this host.
    }
  }
}
