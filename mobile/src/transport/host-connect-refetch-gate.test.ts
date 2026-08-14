import { describe, expect, it } from 'vitest'
import { createHostConnectRefetchGate } from './host-connect-refetch-gate'
import type { ConnectionState } from './types'

function refetchesFor(states: ConnectionState[]): number {
  const gate = createHostConnectRefetchGate()
  return states.filter((state) => gate.observe(state)).length
}

describe('createHostConnectRefetchGate', () => {
  it('fetches once on the first connect', () => {
    expect(refetchesFor(['connecting', 'handshaking', 'connected'])).toBe(1)
  })

  it('fetches again after a dropped socket comes back', () => {
    expect(
      refetchesFor(['connected', 'reconnecting', 'connecting', 'handshaking', 'connected'])
    ).toBe(2)
  })

  it('does not storm while the connection holds', () => {
    expect(refetchesFor(['connected', 'connected', 'connected'])).toBe(1)
  })

  it('never fetches while the host stays down', () => {
    expect(refetchesFor(['connecting', 'disconnected', 'reconnecting', 'auth-failed'])).toBe(0)
  })
})
