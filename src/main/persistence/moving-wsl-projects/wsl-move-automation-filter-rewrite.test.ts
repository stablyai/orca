import { describe, expect, it } from 'vitest'
import { toPersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { wslMoveAutomationHostFilterUpdate } from './wsl-move-automation-filter-rewrite'

const desktop = toPersistedAutomationHostFilter({
  kind: 'host',
  host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
})
const otherHost = { kind: 'host' as const, hostKey: 'host:ssh:staging' }

describe('wslMoveAutomationHostFilterUpdate', () => {
  it('widens a filter on this desktop to all hosts when the move carried automations', () => {
    expect(wslMoveAutomationHostFilterUpdate(desktop, 2)).toEqual({ kind: 'all' })
  })

  it('keeps the filter when nothing moved, or it shows all hosts or another host', () => {
    expect(wslMoveAutomationHostFilterUpdate(desktop, 0)).toBeNull()
    expect(wslMoveAutomationHostFilterUpdate({ kind: 'all' }, 2)).toBeNull()
    expect(wslMoveAutomationHostFilterUpdate(otherHost, 2)).toBeNull()
    expect(wslMoveAutomationHostFilterUpdate(undefined, 2)).toBeNull()
  })
})
