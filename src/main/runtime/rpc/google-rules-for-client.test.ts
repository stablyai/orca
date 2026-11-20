import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { GOOGLE_TRIGGERS_RUNTIME_CAPABILITY } from '../../../shared/google/google-connect-types'
import { automationForClient } from './google-rules-for-client'

const slack = { id: 'slack', source: 'slack', event: 'mentioned' } as const
const on: NonNullable<Automation['on']> = [
  { id: 'mail', source: 'gmail', event: 'new_email' },
  slack
]
describe('Google rules for a paired client', () => {
  it('keeps them for local callers and clients that read them', () => {
    expect(automationForClient({ on }, {}).on).toEqual(on)
    expect(
      automationForClient({ on }, { clientCapabilities: [GOOGLE_TRIGGERS_RUNTIME_CAPABILITY] }).on
    ).toEqual(on)
  })

  it('drops them for an older client', () => {
    expect(automationForClient({ on }, { clientCapabilities: [] }).on).toEqual([slack])
  })
})
