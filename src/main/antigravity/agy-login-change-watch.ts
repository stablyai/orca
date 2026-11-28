import { watch, type FSWatcher } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { getAntigravityWindowsHome } from './native-windows-credentials'
import { readAntigravityMacOSCredentialRevision } from './native-macos-credentials'

const SETTLE_MS = 500

let loginRevision = 0
// By store folder. A folder agy hasn't created yet is waited for from its nearest existing parent;
// a watch that failed is tried again on the next call.
const watchers = new Map<string, FSWatcher>()
// What each store held when last read; a write that leaves agy's login as it was is ignored.
const seen = new Map<string, string>()
const pending = new Set<AgyLoginStore>()
let settle: ReturnType<typeof setTimeout> | null = null
let followers = 0

type AgyLoginStore = { dir: string; file: string; keychain: boolean }

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

function agyLoginStores(home: string): AgyLoginStore[] {
  const stores = [
    {
      dir: join(home, '.gemini', 'antigravity-cli'),
      file: 'antigravity-oauth-token',
      keychain: false
    }
  ]
  if (process.platform === 'darwin') {
    stores.push({
      dir: join(home, 'Library', 'Keychains'),
      file: 'login.keychain-db',
      keychain: true
    })
  }
  return stores
}

/** The login keychain holds every app's passwords, so only agy's item, read by its attributes
 *  (no access dialog), says whether agy's login changed; a write in the same second as the last
 *  one can't be told apart, so it counts. */
async function storeContents(store: AgyLoginStore): Promise<string> {
  if (store.keychain) {
    const revision = await readAntigravityMacOSCredentialRevision().catch(() => undefined)
    return revision === undefined
      ? 'unreadable'
      : revision === null
        ? 'none'
        : revision.settled
          ? revision.fingerprint
          : `${revision.fingerprint}:${Date.now()}`
  }
  const file = await stat(join(store.dir, store.file)).catch(() => null)
  return file ? `${file.ino}:${file.size}:${file.mtimeMs}` : 'none'
}

async function publishChanges(): Promise<void> {
  const stores = [...pending]
  pending.clear()
  let moved = false
  for (const store of stores) {
    const contents = await storeContents(store)
    if (seen.get(store.dir) !== contents) {
      seen.set(store.dir, contents)
      moved = true
    }
  }
  if (moved && followers > 0) {
    loginRevision += 1
    // A new revision makes every sign-in subscriber publish, carrying the login revision.
    antigravityChatSignIn.set(antigravityChatSignIn.get().value)
  }
}

function changed(store: AgyLoginStore): void {
  pending.add(store)
  if (settle) {
    clearTimeout(settle)
  }
  settle = setTimeout(() => {
    settle = null
    void publishChanges()
  }, SETTLE_MS)
  settle.unref?.()
}

/** Watches `dir` for `file`, or, until agy creates `dir`, the nearest existing parent for the next
 *  folder on the way down, then moves down as each appears. */
function attach(store: AgyLoginStore, home: string): void {
  const { dir, file } = store
  let at = dir
  for (;;) {
    const target = at
    // The entry under `target` that leads to the store: the store file itself once `target` is `dir`.
    const next = target === dir ? file : relative(target, dir).split(sep)[0]
    try {
      const watcher = watch(target, { persistent: false }, (event, name) => {
        const toStore = !name || name.toString() === next
        if (target === dir) {
          if (toStore) {
            changed(store)
          }
          // The store's folder itself may have gone away: wait for it again from its parent.
          if (event === 'rename') {
            void access(dir).catch(() => {
              if (watchers.get(dir) === watcher) {
                moveOn()
              }
            })
          }
          return
        }
        if (toStore) {
          moveOn()
        }
      })
      // A folder on the way to the store appeared, or the store's folder went away: watch from the
      // nearest folder that exists, and read once in case agy wrote its login meanwhile.
      const moveOn = () => {
        watcher.close()
        watchers.delete(dir)
        attach(store, home)
        changed(store)
      }
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

/** Watches every store not watched yet while a client follows agy's sign-in; the returned
 *  release stops watching once the last one leaves. */
export function watchAgyLoginChanges(): () => void {
  followers += 1
  let stores: AgyLoginStore[] = []
  let home = ''
  try {
    home = agyLoginHome()
    stores = agyLoginStores(home)
  } catch {
    // Nothing to watch on this host.
  }
  for (const store of stores) {
    if (!watchers.has(store.dir)) {
      attach(store, home)
      void storeContents(store).then((contents) => {
        if (!seen.has(store.dir)) {
          seen.set(store.dir, contents)
        }
      })
    }
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    followers -= 1
    if (followers === 0) {
      for (const watcher of watchers.values()) {
        watcher.close()
      }
      watchers.clear()
      seen.clear()
    }
  }
}
