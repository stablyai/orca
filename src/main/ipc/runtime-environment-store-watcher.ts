import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { getEnvironmentStorePath, listEnvironments } from '../../shared/runtime-environment-store'

export const RUNTIME_ENVIRONMENTS_CHANGED_CHANNEL = 'runtimeEnvironments:changed'

type StoreWatcherWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string): void }
}

type RuntimeEnvironmentStoreWatcherOptions = {
  userDataPath: string
  getWindows: () => StoreWatcherWindow[]
  /** Retires transports for environments that were removed or re-paired outside the app (e.g. `orca environment rm`). */
  invalidateTransport: (environmentId: string) => void | Promise<void>
  debounceMs?: number
}

// Why: lastUsedAt rewrites land at a ≥60s cadence, so a short window only has to
// coalesce the tmp-write + rename burst of a single store publication.
const DEFAULT_DEBOUNCE_MS = 200

type StoreFingerprint = Map<string, number>

function readStoreFingerprint(userDataPath: string): StoreFingerprint | null {
  try {
    return new Map(
      listEnvironments(userDataPath).map((environment) => [
        environment.id,
        environment.pairingRevision ?? environment.createdAt
      ])
    )
  } catch {
    // A torn or invalid store file must not broadcast; keep the last-known state.
    return null
  }
}

/**
 * Watches the saved-environments store for external writers (the `orca` CLI)
 * and notifies renderers so a newly paired remote server surfaces without a
 * visit to Settings → Remote Orca Servers.
 *
 * Only membership and pairing-revision changes broadcast: markEnvironmentUsed
 * rewrites the same entries on runtime round-trips and must stay silent.
 */
export function registerRuntimeEnvironmentStoreWatcher(
  options: RuntimeEnvironmentStoreWatcherOptions
): () => void {
  const { userDataPath, getWindows, invalidateTransport } = options
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const storePath = getEnvironmentStorePath(userDataPath)
  const watchedName = basename(storePath)
  let fingerprint = readStoreFingerprint(userDataPath) ?? new Map<string, number>()
  let debounceTimer: NodeJS.Timeout | null = null
  let closed = false

  const handleStoreMaybeChanged = (): void => {
    debounceTimer = null
    const next = readStoreFingerprint(userDataPath)
    if (closed || next === null) {
      return
    }
    const retiredIds = [...fingerprint].filter(([id, revision]) => next.get(id) !== revision)
    const changed = retiredIds.length > 0 || next.size !== fingerprint.size
    fingerprint = next
    if (!changed) {
      return
    }
    // Why: a same-id re-pair or removal outside the app must retire transports that
    // still authenticate as the old peer — parity with the remove/re-pair IPC handlers.
    for (const [environmentId] of retiredIds) {
      // Retirement settles on its own; the broadcast below must not wait on browser-host teardown.
      void invalidateTransport(environmentId)
    }
    for (const window of getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(RUNTIME_ENVIRONMENTS_CHANGED_CHANNEL)
      }
    }
  }

  let watcher: FSWatcher
  try {
    // Why: the store publishes via tmp-write + rename, so watch the parent
    // directory — a watch on the file inode detaches after the first update.
    watcher = watch(dirname(storePath), (_event, changedName) => {
      if (closed || (changedName !== null && changedName.toString() !== watchedName)) {
        return
      }
      debounceTimer ??= setTimeout(handleStoreMaybeChanged, debounceMs)
    })
  } catch (error) {
    console.warn('[runtime-environments] store watch unavailable:', error)
    return () => {}
  }
  // Why: the watch must not keep the process alive during shutdown.
  watcher.unref?.()
  watcher.on('error', (error) => {
    // Degrade to today's behavior (boot/settings hydration) rather than crash.
    console.warn('[runtime-environments] store watch failed:', error)
    watcher.close()
  })

  return () => {
    closed = true
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    watcher.close()
  }
}
