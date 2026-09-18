import { describe, expect, it, vi } from 'vitest'
import { ProfilePreferences, notifyUIChanged } from './profile-preferences'

describe('ProfilePreferences UI change notifications', () => {
  function createPreferences() {
    const runtime = {
      activeViewPreference: { get: () => 'workspace' as const, set: vi.fn() },
      githubCacheDirty: false,
      githubCacheGeneration: 0,
      protectedSecrets: { removeRetainedBlob: vi.fn() },
      settingsChangeListeners: new Set(),
      state: {
        ui: { activeView: 'workspace' },
        settings: {}
      },
      uiChangeListeners: new Set()
    }
    const scheduling = {
      pendingWrite: null,
      writeTimer: null,
      saveLock: null
    }
    return new ProfilePreferences(runtime as never, scheduling as never)
  }

  it('notifies registered listeners of UI state changes', () => {
    const prefs = createPreferences()
    const listener = vi.fn()
    prefs.onUIChanged(listener)

    notifyUIChanged(prefs)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ activeView: 'workspace' }))
  })

  it('isolates listener errors so subsequent listeners still run', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prefs = createPreferences()
    const failingListener = vi.fn(() => {
      throw new Error('Listener crash')
    })
    const succeedingListener = vi.fn()

    prefs.onUIChanged(failingListener)
    prefs.onUIChanged(succeedingListener)

    expect(() => notifyUIChanged(prefs)).not.toThrow()
    expect(failingListener).toHaveBeenCalledTimes(1)
    expect(succeedingListener).toHaveBeenCalledTimes(1)
    expect(consoleSpy).toHaveBeenCalledWith(
      '[preferences] Failed to notify UI change listener:',
      expect.any(Error)
    )
  })

  it('unsubscribes listeners correctly', () => {
    const prefs = createPreferences()
    const listener = vi.fn()
    const unsubscribe = prefs.onUIChanged(listener)

    unsubscribe()
    notifyUIChanged(prefs)

    expect(listener).not.toHaveBeenCalled()
  })

  it('no-ops when there are no listeners registered', () => {
    const prefs = createPreferences()
    expect(() => notifyUIChanged(prefs)).not.toThrow()
  })
})
