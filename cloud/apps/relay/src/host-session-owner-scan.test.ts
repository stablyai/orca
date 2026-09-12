import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { HostSessionRegistry, type HostSession } from './host-session-registry.js'

describe('host data owner lookup', () => {
  it.each([0, 299, 599, -1])('stops at the first owner (position %s)', async (ownerIndex) => {
    const recordAuth = vi.fn()
    const registry = new HostSessionRegistry(
      ...([{}, vi.fn(), {}, {}, {}, { recordAuth }] as unknown as ConstructorParameters<
        typeof HostSessionRegistry
      >)
    )
    const sessions = (registry as unknown as { sessions: Map<string, HostSession> }).sessions
    for (let index = 0; index < 600; index++) {
      sessions.set(`host-${index}`, {
        relayHostId: `host-${index}`,
        pendingConns: new Map(index === ownerIndex ? [['connection', { connTicket: 'secret' }]] : [])
      } as unknown as HostSession)
    }
    let visited = 0
    const values = sessions.values.bind(sessions)
    vi.spyOn(sessions, 'values').mockImplementation(() => {
      const iterator = values()
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const result = next()
        if (!result.done) visited++
        return result
      }
      return iterator
    })
    const close = vi.fn()
    expect(
      await registry.acceptHostData({ close } as unknown as WebSocket, 'connection', 'wrong', 1)
    ).toBe(false)
    expect(close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'invalid host data ticket'
    )
    expect(recordAuth).toHaveBeenCalledExactlyOnceWith(false)
    expect(visited).toBe(ownerIndex === -1 ? 600 : ownerIndex + 1)
  })
})
