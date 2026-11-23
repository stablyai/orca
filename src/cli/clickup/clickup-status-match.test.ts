import { describe, expect, it } from 'vitest'
import type { ClickUpStatusOption } from '../../shared/clickup/clickup-types'
import { resolveClickUpStatusName } from './clickup-status-match'

const statuses: ClickUpStatusOption[] = [
  { name: 'to do', color: '#87909e', type: 'open', orderIndex: 0 },
  { name: 'In Review', color: '#a875ff', type: 'custom', orderIndex: 1 },
  { name: 'complete', color: '#6bc950', type: 'closed', orderIndex: 2 }
]

describe('orca clickup status set --to', () => {
  it('resolves to the list status name regardless of casing or padding', () => {
    expect(resolveClickUpStatusName('  in review ', statuses)).toBe('In Review')
    expect(resolveClickUpStatusName('COMPLETE', statuses)).toBe('complete')
  })

  it('does not match a status by prefix', () => {
    expect(() => resolveClickUpStatusName('in', statuses)).toThrow('Valid statuses')
  })
})
