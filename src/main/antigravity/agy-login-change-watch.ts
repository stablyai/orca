import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { getAntigravityWindowsHome } from './native-windows-credentials'
import { readAntigravityMacOSCredentialRevision } from './native-macos-credentials'

const SETTLE_MS = 500
const REWATCH_MS = 1000

let loginRevision = 0
// By store folder. A folder agy hasn't created yet is waited for from its nearest existing parent.
const watchers = new Map<string, FSWatcher>()
// What each store held when last read; a write that leaves agy's login as it was is ignored.
const seen = new Map<string, string>()
// Stores to check once changes settle, by folder.
const pending = new Map<string, AgyLoginStore>()
let settle: ReturnType<typeof setTimeout> | null = null
let followers = 0
// Moves when the last follower leaves, so checks begun before then publish nothing.
let generation = 0

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
 *  (no access dialog), says whether agy's login changed. `uncertain`: agy wrote it within the
 *  last second, when another write would keep the same attributes, so the read counts as a change. */
async function storeContents(
  store: AgyLoginStore
): Promise<{ contents: string; uncertain: boolean }> {
  if (store.keychain) {
    const revision = await readAntigravityMacOSCredentialRevision().catch(() => undefined)
    return revision === undefined
      ? { contents: 'unreadable', uncertain: false }
      : revision === null
        ? { contents: 'none', uncertain: false }
        : { contents: revision.fingerprint, uncertain: !revision.settled }
  }
  const file = await stat(join(store.dir, store.file)).catch(() => null)
  return { contents: file ? `${file.ino}:${file.size}:${file.mtimeMs}` : 'none', uncertain: false }
}

async function publishChanges(): Promise<void> {
  const at = generation
  const stores = [...pending.values()]
  pending.clear()
  let moved = false
  for (const store of stores) {
    const { contents, uncertain } = await storeContents(store)
    if (at !== generation) {
      return
    }
    if (uncertain || seen.get(store.dir) !== contents) {
      seen.set(store.dir, contents)
      moved = true
    }
  }
  if (moved) {
    loginRevision += 1
    // A new revision makes every sign-in subscriber publish, carrying the login revision.
    antigravityChatSignIn.set(antigravityChatSignIn.get().value)
  }
}

function changed(store: AgyLoginStore): void {
  if (followers === 0) {
    return
  }
  pending.set(store.dir, store)
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
          // The store's folder itself may have been removed or replaced: follow the one there now.
          if (event === 'rename') {
            void stat(dir).then(
              (now) => now.ino !== folder && watchers.get(dir) === watcher && moveOn(),
              () => watchers.get(dir) === watcher && moveOn()
            )
          }
          return
        }
        if (toStore) {
          moveOn()
        }
      })
      let folder: number | null = null
      if (target === dir) {
        void stat(dir).then(
          (now) => (folder = now.ino),
          () => {}
        )
      }
      // A folder on the way to the store appeared, or the store's folder went away: watch from the
      // nearest folder that exists, and read once in case agy wrote its login meanwhile.
      const moveOn = () => {
        watcher.close()
        watchers.delete(dir)
        attach(store, home)
        changed(store)
      }
      // Windows reports a removed folder as a watch error: watch again shortly.
      watcher.on('error', () => {
        watcher.close()
        if (watchers.get(dir) !== watcher) {
          return
        }
        watchers.delete(dir)
        const at = generation
        setTimeout(() => {
          if (at === generation && !watchers.has(dir)) {
            attach(store, home)
            changed(store)
          }
        }, REWATCH_MS).unref?.()
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
  const at = generation
  for (const store of stores) {
    if (!watchers.has(store.dir)) {
      attach(store, home)
      void storeContents(store).then(({ contents }) => {
        if (at === generation && !seen.has(store.dir)) {
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
      generation += 1
      for (const watcher of watchers.values()) {
        watcher.close()
      }
      watchers.clear()
      seen.clear()
      pending.clear()
      if (settle) {
        clearTimeout(settle)
        settle = null
      }
    }
  }
}
