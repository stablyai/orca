import { describe, expect, it } from 'vitest'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import { mobileOptionsPillLabel } from './mobile-native-chat-session-option-labels'

function permissionMode(
  currentValue: string,
  valueSource: SessionOptionDescriptor['valueSource'] = 'reported'
): SessionOptionDescriptor {
  return {
    id: 'permissionMode',
    label: 'Plan mode',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue,
      choices: [
        { value: 'bypassPermissions', label: 'Bypass permissions' },
        { value: 'plan', label: 'Plan' }
      ]
    },
    valueSource,
    transport: 'agent-session',
    settable: true
  }
}

describe('mobileOptionsPillLabel', () => {
  it('shows only provider-confirmed Plan mode in the collapsed pill', () => {
    expect(mobileOptionsPillLabel([permissionMode('bypassPermissions')])).toBe('Options')
    expect(mobileOptionsPillLabel([permissionMode('plan', 'dispatched')])).toBe('Options')
    expect(mobileOptionsPillLabel([permissionMode('plan')])).toBe('Plan')
  })
})
