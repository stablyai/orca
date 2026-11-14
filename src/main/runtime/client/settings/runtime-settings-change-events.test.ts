import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { publishSettingsChanges } from './runtime-settings-change-events'

type Listener = (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void

function settingsStore(initial: GlobalSettings) {
  let settings = initial
  const listeners = new Set<Listener>()
  return {
    getSettings: () => settings,
    onSettingsChanged: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // Like the real store: replace the object, then pass listeners what the writer sent.
    update: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      for (const listener of listeners) {
        listener(updates, settings)
      }
    }
  }
}

describe('publishSettingsChanges', () => {
  it('names only the settings whose values changed', () => {
    const store = settingsStore({
      ...getDefaultSettings('/home/me'),
      prBotAuthorOverrides: ['renovate'],
      diffShowWhitespace: false
    })
    const events: RuntimeClientEvent[] = []
    publishSettingsChanges(store, (event) => events.push(event))

    store.update({
      prBotAuthorOverrides: ['renovate'],
      diffShowWhitespace: true
    })
    store.update({ diffShowWhitespace: true })

    expect(events).toEqual([{ type: 'settingsChanged', keys: ['diffShowWhitespace'] }])
  })
})
