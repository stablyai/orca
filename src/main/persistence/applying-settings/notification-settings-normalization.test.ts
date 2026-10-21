import { describe, expect, it } from 'vitest'
import {
  normalizeNotificationSettings,
  persistedNotificationSettingsRepaired
} from './onboarding-normalization'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'

describe('muted notification machines', () => {
  it('keeps valid machine ids once and drops anything else', () => {
    const normalized = normalizeNotificationSettings({
      mutedNotificationSourceIds: [
        'runtime:m4air',
        'ssh:openclaw',
        'runtime:m4air',
        'nope',
        42,
        'local'
      ]
    })
    expect(normalized.mutedNotificationSourceIds).toEqual([
      'runtime:m4air',
      'ssh:openclaw',
      'local'
    ])
  })

  it('defaults a missing or malformed list to no muted machines', () => {
    expect(normalizeNotificationSettings({}).mutedNotificationSourceIds).toEqual([])
    expect(
      normalizeNotificationSettings({ mutedNotificationSourceIds: 'runtime:m4air' })
        .mutedNotificationSourceIds
    ).toEqual([])
  })

  it('does not count an unchanged list as a repair', () => {
    // Why: a fresh array never equals the stored one by reference; a false repair rewrites settings on every launch.
    const persisted = {
      ...getDefaultNotificationSettings(),
      mutedNotificationSourceIds: ['runtime:m4air']
    }
    const normalized = normalizeNotificationSettings(persisted)
    expect(persistedNotificationSettingsRepaired(persisted, normalized)).toBe(false)
  })

  it('counts a dropped entry as a repair', () => {
    const persisted = { ...getDefaultNotificationSettings(), mutedNotificationSourceIds: ['nope'] }
    const normalized = normalizeNotificationSettings(persisted)
    expect(persistedNotificationSettingsRepaired(persisted, normalized)).toBe(true)
  })
})
