import { describe, expect, it } from 'vitest'
import { WORKSPACE_SORT_OPTIONS } from './workspace-list-picker-options'

describe('WORKSPACE_SORT_OPTIONS', () => {
  it('keeps the persisted sort values stable for desktop compatibility', () => {
    expect(WORKSPACE_SORT_OPTIONS.map((option) => option.value)).toEqual([
      'smart',
      'name',
      'recent',
      'repo',
      'manual'
    ])
  })

  it('keeps the smart sort value while showing the agent activity label', () => {
    expect(WORKSPACE_SORT_OPTIONS.find((option) => option.value === 'smart')).toEqual({
      value: 'smart',
      label: 'Agent activity',
      subtitle: 'Agents that need attention, then recent activity'
    })
  })
})
