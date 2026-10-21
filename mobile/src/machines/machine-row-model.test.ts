import { describe, expect, it, vi } from 'vitest'

vi.mock('../theme/mobile-theme', () => ({
  colors: { statusGreen: 'green', statusAmber: 'amber', statusRed: 'red', textMuted: 'muted' }
}))

import { machineRowModel } from './machine-row-model'

const base = { id: 'm', name: 'dev', lastSeenAt: 0 }

describe('machineRowModel', () => {
  it('offers Sleep on a running machine and Wake on a sleeping or archived one', () => {
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'running' }, 0, 0)
    ).toMatchObject({ stateLabel: 'Running', action: 'sleep', subtitle: 'Persistent' })
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'sleeping' }, 0, 0).action
    ).toBe('wake')
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'archived' }, 0, 0).action
    ).toBe('wake')
    expect(machineRowModel({ ...base, lifetime: 'persistent', state: 'gone' }, 0, 0)).toMatchObject(
      {
        stateLabel: 'Gone',
        stateColor: 'red',
        action: null
      }
    )
  })

  it('shows a sleep still in progress as Sleeping… with no action', () => {
    expect(
      machineRowModel({ ...base, lifetime: 'persistent', state: 'stopping' }, 0, 0)
    ).toMatchObject({ stateLabel: 'Sleeping…', action: null })
  })

  it('reads states through the shared rules, like the desktop', () => {
    const row = (state: string) => machineRowModel({ ...base, lifetime: 'persistent', state }, 0, 0)
    expect(row('waking')).toMatchObject({ stateLabel: 'Starting', action: null })
    expect(row('error')).toMatchObject({ stateLabel: 'Error', action: null })
    // A state from a newer desktop reads as Unreachable, never blank.
    expect(row('hibernating')).toMatchObject({ stateLabel: 'Unreachable', action: null })
  })

  it("offers only the provider's declared verbs", () => {
    const running = { ...base, lifetime: 'persistent', state: 'running' }
    expect(machineRowModel(running, 0, 0, ['get', 'wake']).action).toBeNull()
    expect(machineRowModel(running, 0, 0, ['sleep']).action).toBe('sleep')
  })

  it('reads expiry on the provider clock', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    const machine = {
      ...base,
      lifetime: 'temporary' as const,
      state: 'running',
      expiresAt: '2026-10-18T12:00:30Z'
    }
    // The provider runs a minute ahead, so its 12:00:30 has already passed here.
    expect(machineRowModel(machine, 60_000, now).subtitle).toBe('Temporary · expired')
    expect(machineRowModel(machine, 0, now).subtitle).toMatch(/^Temporary · deletes at /)
  })

  it('names the year for a far expiry and shows no lifetime it does not know', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(
      machineRowModel(
        { ...base, lifetime: 'temporary', state: 'running', expiresAt: '2099-01-01T16:12:00Z' },
        0,
        now
      ).subtitle
    ).toContain('2099')
    expect(
      machineRowModel({ ...base, lifetime: 'forever', state: 'running' }, 0, now).subtitle
    ).toBe('')
  })
})
