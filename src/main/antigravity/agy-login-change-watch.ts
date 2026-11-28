import { watch, type FSWatcher } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { getAntigravityWindowsHome } from './native-windows-credentials'

const SETTLE_MS = 500

let loginRevision = 0
// By store folder. A folder agy hasn't created yet is waited for from its nearest existing parent;
// a watch that failed is tried again on the next call.
const watchers = new Map<string, FSWatcher>()
let settle: ReturnType<typeof setTimeout> | null = null

/** Counts the changes seen to agy's stored login, which Settings reads again on each. */
export function agyLoginRevision(): number {
  return loginRevision
}

/** Where agy keeps its login: its token file everywhere, and on macOS the login keychain, whose
 *  database is rewritten when agy stores a new login. The Linux keyring and Windows Credential
 *  Manager have no file to watch, so those hosts re-read on Refresh, a sign-in or a reopen. */
function agyLoginHome(): string {
  return process.platform === 'win32'
    ? getAntigravityWindowsHome(process.env)
    : getAppEnvironment().getPath('home')
}

function agyLoginStores(home: string): { dir: string; file: string }[] {
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

/** Watches `dir` for `file`, or, until agy creates `dir`, the nearest existing parent for the next
 *  folder on the way down, then moves down as each appears. */
function attach(dir: string, file: string, home: string): void {
  let at = dir
  for (;;) {
    const target = at
    // The entry under `target` that leads to the store: the store file itself once `target` is `dir`.
    const next = target === dir ? file : relative(target, dir).split(sep)[0]
    try {
      const watcher = watch(target, { persistent: false }, (_event, name) => {
        if (name && name.toString() !== next) {
          return
        }
        if (target === dir) {
          changed()
          return
        }
        // A folder on the way to the store appeared: watch further down, and read once in case
        // agy wrote its login along with the folder.
        watcher.close()
        watchers.delete(dir)
        attach(dir, file, home)
        changed()
      })
      watcher.on('error', () => {
        watcher.close()
        watchers.delete(dir)
      })
      watchers.set(dir, watcher)
      return
    } catch {
      if (target === home || dirname(target) === target) {
        return
      }
      at = dirname(target)
    }
  }
}

/** Called each time a client follows agy's sign-in: watches every store not watched yet. */
export function watchAgyLoginChanges(): void {
  let stores: { dir: string; file: string }[]
  let home: string
  try {
    home = agyLoginHome()
    stores = agyLoginStores(home)
  } catch {
    return
  }
  for (const { dir, file } of stores) {
    if (!watchers.has(dir)) {
      attach(dir, file, home)
    }
  }
}
