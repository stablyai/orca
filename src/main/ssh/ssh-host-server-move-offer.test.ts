import { describe, expect, it } from 'vitest'
import {
  canOfferManagedServerMove,
  relayServerStatus,
  shouldToastManagedServerMove
} from './ssh-host-server-move-offer'

const live = { route: 'relay' as const, reason: 'relay_terminals_live' as const, terminals: 3 }

describe('offering to move a host whose relay terminals keep it on the relay', () => {
  it('offers only when live terminals are the reason', () => {
    expect(canOfferManagedServerMove(live)).toBe(true)
    expect(canOfferManagedServerMove({ reason: 'relay_terminals_unverifiable' })).toBe(false)
    expect(canOfferManagedServerMove({ reason: 'refused' })).toBe(false)
    expect(canOfferManagedServerMove({ reason: 'orcad_unavailable' })).toBe(false)
  })

  it('toasts once per host per app version', () => {
    expect(shouldToastManagedServerMove({}, live, '1.5.0')).toBe(true)
    expect(
      shouldToastManagedServerMove(
        { managedServerMoveOffered: { appVersion: '1.5.0' } },
        live,
        '1.5.0'
      )
    ).toBe(false)
    expect(
      shouldToastManagedServerMove(
        { managedServerMoveOffered: { appVersion: '1.4.0' } },
        live,
        '1.5.0'
      )
    ).toBe(true)
    expect(
      shouldToastManagedServerMove({}, { reason: 'relay_terminals_unverifiable' }, '1.5.0')
    ).toBe(false)
  })

  it('carries the offer and terminal count on the published relay status', () => {
    expect(relayServerStatus(live, true)).toEqual({
      kind: 'relay',
      reason: 'relay_terminals_live',
      terminals: 3,
      offerMove: true
    })
    expect(relayServerStatus(live, false)).not.toHaveProperty('offerMove')
    expect(
      relayServerStatus(
        { route: 'relay', reason: 'refused', detail: 'An automation runs here.' },
        false
      )
    ).toEqual({ kind: 'relay', reason: 'refused', detail: 'An automation runs here.' })
  })

  it('never offers to move terminals another Orca desktop or session runs', () => {
    const elsewhere = { ...live, terminals: 1, terminalsElsewhere: true }
    expect(canOfferManagedServerMove(elsewhere)).toBe(false)
    expect(shouldToastManagedServerMove({}, elsewhere, '1.5.0')).toBe(false)
    expect(relayServerStatus(elsewhere, false)).toEqual({
      kind: 'relay',
      reason: 'relay_terminals_live',
      terminals: 1,
      terminalsElsewhere: true
    })
  })
})
