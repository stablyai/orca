import { extractPortableSettings, type SettingsFileValues } from './settings-file-document'
import type { SettingsFileLog, SettingsFileStatus } from './settings-file-sync-types'

function describeIgnored(ignored: SettingsFileStatus['ignored']): string {
  return ignored.map(({ key, reason }) => `${key} (${reason})`).join(', ')
}

export type SettingsFileStatusTracker = {
  get: () => SettingsFileStatus
  subscribe: (listener: (status: SettingsFileStatus) => void) => () => void
  clearListeners: () => void
  markAbsent: () => void
  markInvalid: (message: string) => void
  markReadOnly: () => void
  markActive: (values: SettingsFileValues) => void
}

// The service has no UI of its own (orcad), so state changes are logged as well as published.
export function createSettingsFileStatusTracker(
  filePath: string,
  log: SettingsFileLog
): SettingsFileStatusTracker {
  let status: SettingsFileStatus = {
    state: 'absent',
    path: filePath,
    appliedKeyCount: 0,
    ignored: []
  }
  const listeners = new Set<(status: SettingsFileStatus) => void>()

  const set = (next: SettingsFileStatus): void => {
    if (JSON.stringify(next) === JSON.stringify(status)) {
      return
    }
    const previous = status
    status = next
    if (next.state === 'invalid') {
      log.warn(`settings file is invalid, changes are not applied: ${next.message ?? ''}`)
    } else if (next.state === 'read-only' && previous.state !== 'read-only') {
      log.warn('settings file is read-only, keeping in-app values')
    }
    if (
      next.ignored.length > 0 &&
      describeIgnored(next.ignored) !== describeIgnored(previous.ignored)
    ) {
      log.info(`settings file keys ignored: ${describeIgnored(next.ignored)}`)
    }
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error) {
        log.warn(`settings file status listener failed: ${String(error)}`)
      }
    }
  }

  return {
    get: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    clearListeners: () => listeners.clear(),
    markAbsent: () => set({ state: 'absent', path: filePath, appliedKeyCount: 0, ignored: [] }),
    markInvalid: (message) => set({ ...status, state: 'invalid', message }),
    markReadOnly: () => set({ ...status, state: 'read-only', message: undefined }),
    markActive: (values) => {
      const { valid, ignored } = extractPortableSettings(values)
      set({ state: 'active', path: filePath, appliedKeyCount: Object.keys(valid).length, ignored })
    }
  }
}
