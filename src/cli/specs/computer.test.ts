import { describe, expect, it } from 'vitest'

import { COMPUTER_COMMAND_SPECS } from './computer'

describe('computer command specs', () => {
  it('allows explicit window targeting on action commands', () => {
    const actionSpecs = COMPUTER_COMMAND_SPECS.filter((spec) =>
      [
        'computer click',
        'computer drag',
        'computer hotkey',
        'computer paste-text',
        'computer perform-secondary-action',
        'computer press-key',
        'computer scroll',
        'computer set-value',
        'computer type-text'
      ].includes(spec.path.join(' '))
    )

    expect(actionSpecs).not.toHaveLength(0)
    for (const spec of actionSpecs) {
      expect(spec.allowedFlags).toEqual(expect.arrayContaining(['window-id', 'window-index']))
    }
  })
})
