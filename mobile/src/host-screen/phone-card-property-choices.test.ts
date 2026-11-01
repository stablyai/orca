import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CARD_DISPLAY_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES
} from '../../../src/shared/workspace-view/workspace-view-options'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'
import {
  phoneCardPropertyChoices,
  withoutPhoneHiddenProperties
} from './phone-card-property-choices'

const ids = (choices: readonly { id: string }[]) => choices.map((choice) => choice.id)

describe('the card properties the phone offers', () => {
  it('hides Ports and keeps Orca CLI', () => {
    expect(ids(phoneCardPropertyChoices(WORKSPACE_CARD_PROPERTY_CHOICES))).not.toContain('ports')
    const display = ids(phoneCardPropertyChoices(WORKSPACE_CARD_DISPLAY_CHOICES))
    expect(display).not.toContain('ports')
    expect(display).toContain('cli')
  })

  it('drops Ports from what it counts without touching the shared value', () => {
    const shared: readonly WorktreeCardProperty[] = Object.freeze(['issue', 'ports', 'cli'])
    expect(withoutPhoneHiddenProperties(shared)).toEqual(['issue', 'cli'])
    expect(shared).toEqual(['issue', 'ports', 'cli'])
  })
})
