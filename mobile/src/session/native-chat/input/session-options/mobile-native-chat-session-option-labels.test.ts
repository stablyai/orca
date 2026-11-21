import { describe, expect, it } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { mobilePermissionSettingsHint } from './mobile-native-chat-session-option-labels'

function permission(
  kind: { reportedValue?: string; currentValue?: string } = {},
  deferred = false
): SessionOptionDescriptor {
  return {
    id: 'permissionMode',
    label: 'Permissions',
    category: 'mode',
    transport: 'agent-session',
    valueSource: deferred ? 'dispatched' : 'applied',
    ...(deferred ? { activeValue: 'ask' } : {}),
    settable: true,
    kind: {
      type: 'select',
      currentValue: 'own',
      settingsAgent: 'codex',
      choices: [{ value: 'ask', label: 'Ask for approval' }],
      ...kind
    }
  }
}

describe('the mobile permission settings hint', () => {
  it('names only the settings for a missing report, and an unnameable report differently', () => {
    const missing = mobilePermissionSettingsHint(permission())
    expect(missing).toBeTruthy()
    const unnamed = mobilePermissionSettingsHint(permission({ reportedValue: 'read-only' }))
    expect(unnamed).toBeTruthy()
    expect(unnamed).not.toBe(missing)
  })

  it('adds nothing once the pill names a mode, Plan or a deferred pick', () => {
    for (const reportedValue of ['full-access', 'plan']) {
      expect(mobilePermissionSettingsHint(permission({ reportedValue }))).toBeUndefined()
    }
    expect(mobilePermissionSettingsHint(permission({}, true))).toBeUndefined()
    expect(mobilePermissionSettingsHint(permission({ currentValue: 'ask' }))).toBeUndefined()
  })
})
