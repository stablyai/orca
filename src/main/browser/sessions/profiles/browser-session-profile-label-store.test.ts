import { expect, it } from 'vitest'
import type { BrowserSessionMeta } from './browser-session-meta-store'
import { BrowserSessionProfileMap } from './browser-session-profile-map'
import { BrowserSessionProfileLabelStore } from './browser-session-profile-label-store'

function store() {
  const profiles = new BrowserSessionProfileMap()
  profiles.set('default', {
    id: 'default',
    scope: 'default',
    partition: 'persist:default',
    label: 'Default',
    source: null
  })
  profiles.set('work', {
    id: 'work',
    scope: 'isolated',
    partition: 'persist:work',
    label: 'Work',
    source: null
  })
  const metaUpdates: Partial<BrowserSessionMeta>[] = []
  let persistedProfiles = 0
  let notifications = 0
  const labels = new BrowserSessionProfileLabelStore(
    profiles,
    (updates) => metaUpdates.push(updates),
    () => {
      persistedProfiles += 1
    },
    () => {
      notifications += 1
    }
  )
  return { labels, profiles, metaUpdates, counts: () => ({ persistedProfiles, notifications }) }
}

it('persists a renamed default in metadata and a custom profile in the list', () => {
  const { labels, profiles, metaUpdates, counts } = store()

  expect(labels.rename('default', '  Main  ')?.label).toBe('Main')
  expect(profiles.get('default')?.label).toBe('Main')
  expect(metaUpdates).toEqual([{ defaultLabel: 'Main' }])

  expect(labels.rename('work', 'Side project')?.label).toBe('Side project')
  expect(metaUpdates).toEqual([{ defaultLabel: 'Main' }])
  expect(counts()).toEqual({ persistedProfiles: 1, notifications: 2 })
})

it('rejects a blank label or unknown profile without changing anything', () => {
  const { labels, profiles, metaUpdates, counts } = store()

  expect(labels.rename('work', '  ')).toBeNull()
  expect(labels.rename('missing', 'Other')).toBeNull()
  expect(profiles.get('work')?.label).toBe('Work')
  expect(metaUpdates).toEqual([])
  expect(counts()).toEqual({ persistedProfiles: 0, notifications: 0 })
})
