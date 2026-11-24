import { createHash } from 'node:crypto'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { PORTABLE_SETTINGS_KEYS } from '../../shared/settings/settings-file/settings-key-portability'
import { parseSettingsFileText, serializeWithUpdates } from './settings-file-document'
import {
  createSettingsFile,
  readSettingsFile,
  writeSettingsFile,
  type SettingsFileRead
} from './settings-file-io'
import { collectNonDefaultPortableSettings } from './settings-file-reconcile'
import { createStoreReconciler } from './settings-file-store-reconciler'
import { startRefreshSweep, type RefreshSweep } from './settings-file-refresh-sweep'
import { createSettingsFileTaskQueue } from './settings-file-task-queue'
import { createSettingsFileStatusTracker } from './settings-file-status'
import type {
  SettingsFileStatus,
  SettingsFileSync,
  SettingsFileSyncDeps
} from './settings-file-sync-types'
import { createSettingsFileWatching, type SettingsFileWatching } from './settings-file-watching'

const DEFAULT_DEBOUNCE_MS = 400
const BUSY_RETRY_BASE_MS = 500
const BUSY_RETRY_MAX_MS = 8_000
const BUSY_MAX_RETRIES = 5
const CHANGED_MAX_RETRIES = 3

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function createSettingsFileSync(deps: SettingsFileSyncDeps): SettingsFileSync {
  const { filePath, store, defaults, log } = deps
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const status = createSettingsFileStatusTracker(filePath, log)
  // Portable keys the UI changed that the file has not received yet; latest value wins.
  const dirty = new Map<string, unknown>()
  // Hash of the file text we last wrote or last read and reconciled; an identical read has nothing new to apply.
  let lastHandledTextHash: string | null = null
  let busyRetries = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let refreshSweep: RefreshSweep | null = null
  let unsubscribe: (() => void) | null = null
  let watching: SettingsFileWatching | null = null
  let closing = false
  let disposed = false
  // Applies and flushes must not interleave, or a flush could write over values an apply is mid-way through.
  const { enqueue, enqueueReporting } = createSettingsFileTaskQueue(log)

  const readFileOrFail = async (): Promise<SettingsFileRead | null> => {
    try {
      return await readSettingsFile(filePath)
    } catch (error) {
      lastHandledTextHash = null
      status.markInvalid(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const { reconcile, recordSeenKeys } = createStoreReconciler({
    store,
    defaults,
    getDirtyKeys: () => new Set(dirty.keys())
  })

  const applyFile = async (): Promise<void> => {
    if (disposed) {
      return
    }
    const read = await readFileOrFail()
    if (!read) {
      return
    }
    if (read.kind === 'missing') {
      lastHandledTextHash = null
      status.markAbsent()
      return
    }
    const textHash = hashText(read.text)
    if (textHash === lastHandledTextHash) {
      return
    }
    lastHandledTextHash = textHash
    const parsed = parseSettingsFileText(read.text)
    if (parsed.kind === 'invalid') {
      status.markInvalid(parsed.message)
      return
    }
    reconcile(parsed.values)
    status.markActive(parsed.values)
  }

  const scheduleBusyRetry = (): void => {
    busyRetries += 1
    const delay = Math.min(BUSY_RETRY_BASE_MS * 2 ** (busyRetries - 1), BUSY_RETRY_MAX_MS)
    clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void enqueue(flushDirty)
    }, delay)
    flushTimer.unref?.()
  }

  async function flushDirty(changedRetries = 0): Promise<void> {
    if (disposed || dirty.size === 0) {
      return
    }
    const snapshot = new Map(dirty)
    const clearSnapshot = (): void => {
      for (const [key, value] of snapshot) {
        if (Object.is(dirty.get(key), value)) {
          dirty.delete(key)
        }
      }
    }
    const read = await readFileOrFail()
    if (!read) {
      return
    }
    if (read.kind === 'missing') {
      lastHandledTextHash = null
      clearSnapshot()
      status.markAbsent()
      return
    }
    const readHash = hashText(read.text)
    const parsed = parseSettingsFileText(read.text)
    if (parsed.kind === 'invalid') {
      lastHandledTextHash = readHash
      status.markInvalid(parsed.message)
      return
    }
    // Reconcile first so an external removal still resets its key before the seen-keys list is rewritten.
    if (readHash !== lastHandledTextHash) {
      lastHandledTextHash = readHash
      reconcile(parsed.values)
    }
    const text = serializeWithUpdates(parsed.values, Object.fromEntries(snapshot), parsed.format)
    const finalValues = parseSettingsFileText(text)
    if (finalValues.kind !== 'ok') {
      return
    }
    if (text !== read.text) {
      const result = await writeSettingsFile(filePath, text, read.text)
      if (result.kind === 'changed') {
        // Edited externally mid-write: re-read, merge that edit, and patch the dirty keys again.
        if (changedRetries < CHANGED_MAX_RETRIES) {
          return flushDirty(changedRetries + 1)
        }
        if (!closing) {
          scheduleFlush()
        }
        return
      }
      if (result.kind === 'missing') {
        lastHandledTextHash = null
        busyRetries = 0
        clearSnapshot()
        status.markAbsent()
        return
      }
      if (result.kind === 'busy') {
        if (busyRetries < BUSY_MAX_RETRIES) {
          if (!closing) {
            scheduleBusyRetry()
          }
          return
        }
        busyRetries = 0
        clearSnapshot()
        status.markReadOnly()
        return
      }
      if (result.kind === 'read-only') {
        busyRetries = 0
        clearSnapshot()
        status.markReadOnly()
        return
      }
      lastHandledTextHash = hashText(text)
    }
    busyRetries = 0
    clearSnapshot()
    recordSeenKeys(finalValues.values)
    status.markActive(finalValues.values)
  }

  const handleFileEvent = async (): Promise<void> => {
    if (disposed) {
      return
    }
    await applyFile()
    await watching?.rebindTarget()
    if (dirty.size > 0 && flushTimer === undefined) {
      await flushDirty()
    }
  }

  const scheduleFlush = (): void => {
    clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void enqueue(flushDirty)
    }, debounceMs)
    flushTimer.unref?.()
  }

  const onSettingsPersisted = (
    changed: Partial<GlobalSettings>,
    origin: 'settings-file' | undefined
  ): void => {
    if (origin === 'settings-file' || disposed) {
      return
    }
    let touched = false
    for (const key of PORTABLE_SETTINGS_KEYS) {
      if (Object.hasOwn(changed, key)) {
        dirty.set(key, changed[key])
        touched = true
      }
    }
    if (touched) {
      scheduleFlush()
    }
  }

  const flush = (): Promise<void> => {
    clearTimeout(flushTimer)
    flushTimer = undefined
    return enqueue(flushDirty)
  }

  // Failures reach the caller so the Create action can report them.
  const createFromCurrentSettings = (): Promise<SettingsFileStatus> =>
    enqueueReporting(async () => {
      if (disposed) {
        return
      }
      const probe = await readFileOrFail()
      if (!probe) {
        return
      }
      if (probe.kind !== 'missing') {
        await handleFileEvent()
        return
      }
      const document = collectNonDefaultPortableSettings(store.getSettings(), defaults)
      const text = serializeWithUpdates({}, document)
      const result = await createSettingsFile(filePath, text)
      if (result.kind === 'read-only') {
        status.markReadOnly()
        return
      }
      if (result.kind === 'exists') {
        await handleFileEvent()
        return
      }
      lastHandledTextHash = hashText(text)
      recordSeenKeys(document)
      status.markActive(document)
      await watching?.refreshLink()
      await watching?.rebindTarget()
    }).then(status.get)

  const refresh = async (): Promise<void> => {
    try {
      await enqueue(handleFileEvent)
      await watching?.refreshLink()
    } catch (error) {
      log.warn(
        `settings file refresh failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return {
    start: async () => {
      // Subscribe first so UI changes made while the first read is slow are kept and written back.
      unsubscribe = store.onSettingsPersisted(onSettingsPersisted)
      await enqueue(applyFile)
      if (closing) {
        return
      }
      const created = createSettingsFileWatching({
        filePath,
        watchFile: deps.watchFile,
        onChange: () => void enqueue(handleFileEvent),
        onError: (error) => log.warn(`settings file watch error: ${error.message}`)
      })
      watching = created
      await created.rebindTarget()
      if (closing) {
        return
      }
      refreshSweep = startRefreshSweep(async () => {
        const before = lastHandledTextHash
        await refresh()
        return { changed: lastHandledTextHash !== before }
      }, deps.refreshIntervalMs)
    },
    refresh,
    flush,
    getStatus: status.get,
    onStatusChanged: status.subscribe,
    createFromCurrentSettings,
    dispose: async () => {
      closing = true
      refreshSweep?.stop()
      refreshSweep = null
      unsubscribe?.()
      unsubscribe = null
      await flush()
      disposed = true
      await watching?.close()
      watching = null
      status.markAbsent()
      status.clearListeners()
    }
  }
}
