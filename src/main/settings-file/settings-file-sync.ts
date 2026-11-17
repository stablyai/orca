import { createHash } from 'node:crypto'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { PORTABLE_SETTINGS_KEYS } from '../../shared/settings/settings-file/settings-key-portability'
import {
  extractPortableSettings,
  parseSettingsFileText,
  serializeWithUpdates,
  type SettingsFileValues
} from './settings-file-document'
import {
  createSettingsFile,
  readSettingsFile,
  writeSettingsFile,
  type SettingsFileRead
} from './settings-file-io'
import { reconcileSettingsFile } from './settings-file-reconcile'
import { createSettingsFileStatusTracker } from './settings-file-status'
import type {
  SettingsFileStatus,
  SettingsFileSync,
  SettingsFileSyncDeps
} from './settings-file-sync-types'
import { createSettingsFileWatching, type SettingsFileWatching } from './settings-file-watching'

const DEFAULT_DEBOUNCE_MS = 400

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function createSettingsFileSync(deps: SettingsFileSyncDeps): SettingsFileSync {
  const { filePath, store, defaults, log } = deps
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const status = createSettingsFileStatusTracker(filePath, log)
  // Portable keys the UI changed that the file has not received yet; latest value wins.
  const dirty = new Map<string, unknown>()
  let lastWrittenHash: string | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | null = null
  let watching: SettingsFileWatching | null = null
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  // Applies and flushes must not interleave, or a flush could write over values an apply is mid-way through.
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task).catch((error) => {
      log.warn(
        `settings file task failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    queue = run
    return run
  }

  const readFileOrFail = async (): Promise<SettingsFileRead | null> => {
    try {
      return await readSettingsFile(filePath)
    } catch (error) {
      status.markInvalid(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const recordSeenKeys = (values: SettingsFileValues): void => {
    const seen = Object.keys(extractPortableSettings(values).valid)
    if (!sameList(store.getSettings().settingsFileLastSeenKeys ?? [], seen)) {
      store.updateSettings({ settingsFileLastSeenKeys: seen }, { origin: 'settings-file' })
    }
  }

  const reconcile = (values: SettingsFileValues): void => {
    const { updates, presentKeys } = reconcileSettingsFile({
      values,
      current: store.getSettings(),
      defaults,
      dirtyKeys: new Set(dirty.keys())
    })
    const hasUpdates = Object.keys(updates).length > 0
    if (!hasUpdates && sameList(store.getSettings().settingsFileLastSeenKeys ?? [], presentKeys)) {
      return
    }
    store.updateSettings(
      { ...updates, settingsFileLastSeenKeys: presentKeys },
      { notifyListeners: hasUpdates, origin: 'settings-file' }
    )
  }

  const applyFile = async (): Promise<void> => {
    const read = await readFileOrFail()
    if (!read) {
      return
    }
    if (read.kind === 'missing') {
      status.markAbsent()
      return
    }
    if (hashText(read.text) === lastWrittenHash) {
      return
    }
    // An external edit can restore our last written text; it must not be mistaken for an echo later.
    lastWrittenHash = null
    const parsed = parseSettingsFileText(read.text)
    if (parsed.kind === 'invalid') {
      status.markInvalid(parsed.message)
      return
    }
    reconcile(parsed.values)
    status.markActive(parsed.values)
  }

  const flushDirty = async (): Promise<void> => {
    if (dirty.size === 0) {
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
      clearSnapshot()
      status.markAbsent()
      return
    }
    const parsed = parseSettingsFileText(read.text)
    if (parsed.kind === 'invalid') {
      status.markInvalid(parsed.message)
      return
    }
    // Reconcile first so an external removal still resets its key before the seen-keys list is rewritten.
    if (hashText(read.text) !== lastWrittenHash) {
      reconcile(parsed.values)
    }
    const text = serializeWithUpdates(parsed.values, Object.fromEntries(snapshot))
    const finalValues = parseSettingsFileText(text)
    if (finalValues.kind !== 'ok') {
      return
    }
    if (text !== read.text) {
      const result = await writeSettingsFile(filePath, text)
      if (result.kind === 'missing') {
        clearSnapshot()
        status.markAbsent()
        return
      }
      if (result.kind === 'read-only') {
        clearSnapshot()
        status.markReadOnly()
        return
      }
      lastWrittenHash = hashText(text)
    }
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

  const createFromCurrentSettings = (): Promise<SettingsFileStatus> =>
    enqueue(async () => {
      if ((await readFileOrFail())?.kind !== 'missing') {
        return
      }
      const current = store.getSettings()
      const document: Record<string, unknown> = {}
      for (const key of PORTABLE_SETTINGS_KEYS) {
        if (current[key] !== undefined && !Object.is(current[key], defaults[key])) {
          document[key] = current[key]
        }
      }
      const text = serializeWithUpdates({}, document)
      const result = await createSettingsFile(filePath, text)
      if (result.kind === 'read-only') {
        status.markReadOnly()
        return
      }
      if (result.kind === 'exists') {
        return
      }
      lastWrittenHash = hashText(text)
      recordSeenKeys(document)
      status.markActive(document)
      await watching?.refreshLink()
      await watching?.rebindTarget()
    }).then(status.get)

  return {
    start: async () => {
      await enqueue(applyFile)
      unsubscribe = store.onSettingsPersisted(onSettingsPersisted)
      watching = createSettingsFileWatching({
        filePath,
        watchFile: deps.watchFile,
        onChange: () => void enqueue(handleFileEvent),
        onError: (error) => log.warn(`settings file watch error: ${error.message}`)
      })
      await watching.rebindTarget()
    },
    refresh: async () => {
      await enqueue(handleFileEvent)
      await watching?.refreshLink()
    },
    flush,
    getStatus: status.get,
    onStatusChanged: status.subscribe,
    createFromCurrentSettings,
    dispose: async () => {
      unsubscribe?.()
      unsubscribe = null
      await flush()
      disposed = true
      await watching?.close()
      watching = null
      status.clearListeners()
    }
  }
}
