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

describe('agent notification mode persistence', () => {
  it.each([undefined, null, 'unknown', true, 42])(
    'defaults %s to current behavior',
    (agentNotificationMode) => {
      expect(normalizeNotificationSettings({ agentNotificationMode }).agentNotificationMode).toBe(
        'current'
      )
    }
  )
  it('preserves the opt-in mode across normalization and marks invalid persisted modes for repair', () => {
    const saved = {
      ...getDefaultNotificationSettings(),
      agentNotificationMode: 'action-or-flow-complete'
    }
    expect(normalizeNotificationSettings(saved).agentNotificationMode).toBe(
      'action-or-flow-complete'
    )
    expect(persistedNotificationSettingsRepaired(saved, normalizeNotificationSettings(saved))).toBe(
      false
    )
    const invalid = { ...saved, agentNotificationMode: 'invalid' }
    expect(
      persistedNotificationSettingsRepaired(invalid, normalizeNotificationSettings(invalid))
    ).toBe(true)
  })
})
