import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings, getDefaultUIState } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { publishWorkspaceViewChanges } from './runtime-workspace-view-change-events'

function fakeStore() {
  let ui: PersistedUIState = getDefaultUIState()
  const listeners: ((ui: PersistedUIState) => void)[] = []
  const settingsListeners: ((
    updates: Partial<GlobalSettings>,
    settings: GlobalSettings
  ) => void)[] = []
  return {
    getUI: () => ui,
    onUIChanged: (listener: (ui: PersistedUIState) => void) => {
      listeners.push(listener)
      return () => {}
    },
    onSettingsChanged: (
      listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
    ) => {
      settingsListeners.push(listener)
      return () => {}
    },
    updateSettings(updates: Partial<GlobalSettings>) {
      for (const listener of settingsListeners) {
        listener(updates, { ...getDefaultSettings('/home/test'), ...updates })
      }
    },
    update(updates: Partial<PersistedUIState>) {
      ui = { ...ui, ...updates }
      for (const listener of listeners) {
        listener(ui)
      }
    }
  }
}

describe('publishWorkspaceViewChanges', () => {
  it('announces a Workspace options change once, and ignores unrelated UI edits', () => {
    const store = fakeStore()
    const emit = vi.fn()
    publishWorkspaceViewChanges(store, emit)

    store.update({ sidebarWidth: 300 })
    expect(emit).not.toHaveBeenCalled()

    store.update({ hideWorkspacesFromOtherDevices: true })
    store.update({ hideWorkspacesFromOtherDevices: true })
    store.update({ filterRepoIds: ['repo-1'] })
    expect(emit.mock.calls).toEqual([
      [{ type: 'workspaceViewChanged' }],
      [{ type: 'workspaceViewChanged' }]
    ])
  })

  it('announces a change to the card layout, card style or pinned placement, and nothing else', () => {
    const store = fakeStore()
    const emit = vi.fn()
    publishWorkspaceViewChanges(store, emit)

    store.updateSettings({ terminalCopyTrimsGutter: false })
    expect(emit).not.toHaveBeenCalled()
    store.updateSettings({ compactWorktreeCards: true })
    store.updateSettings({ experimentalNewWorktreeCardStyle: true })
    store.updateSettings({ showPinnedWorktreesInGroups: true })
    expect(emit).toHaveBeenCalledTimes(3)
  })
})
