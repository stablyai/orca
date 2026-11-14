import { expect, it } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { mobileSessionOptionSummaryValue } from './mobile-native-chat-session-option-labels'

function ownPermission(reported?: { value: string; description: string }): SessionOptionDescriptor {
  return {
    id: 'permissionMode',
    label: 'Permissions',
    description: reported?.description ?? "Agent's own settings",
    category: 'mode',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'own',
      ...(reported ? { reportedValue: reported.value } : {}),
      choices: [{ value: 'full-access', label: 'Full access' }]
    }
  }
}

it('names the mode a chat following its agent settings runs in', () => {
  expect(
    mobileSessionOptionSummaryValue(
      ownPermission({ value: 'full-access', description: 'Full access' })
    )
  ).toBe('Full access')
})

it('names the delegation until the agent reports a mode', () => {
  expect(mobileSessionOptionSummaryValue(ownPermission())).toBe("Agents' own settings")
})
