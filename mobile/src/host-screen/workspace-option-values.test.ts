import { describe, expect, it } from 'vitest'
import { choiceLabel, summarizeChecklist } from './workspace-option-values'

describe('a checklist option value on the main sheet', () => {
  it('reads all, none, the single checked item, or a count', () => {
    expect(summarizeChecklist(['a', 'b', 'c'], 3, 'All hosts')).toBe('All hosts')
    expect(summarizeChecklist([], 3, 'All')).toBe('None')
    expect(summarizeChecklist(['m4 air'], 3, 'All hosts')).toBe('m4 air')
    expect(summarizeChecklist(['a', 'b'], 3, 'All')).toBe('2 of 3')
  })
})

describe('a pick-one option value', () => {
  it("reads the chosen choice's label, and nothing for an unknown id", () => {
    const choices = [
      { id: 'name', label: 'Name' },
      { id: 'recent', label: 'Recent' }
    ]
    expect(choiceLabel(choices, 'recent')).toBe('Recent')
    expect(choiceLabel(choices, 'newer-host-value')).toBe('')
  })
})
