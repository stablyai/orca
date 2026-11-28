import { describe, expect, it } from 'vitest'
import { DaemonToolRelayKeptGrants } from './daemon-tool-relay-kept-grants'

const scout = { owner: 'scout', token: 'tok-scout', folders: { bot: '/bots/scout' } }
const host = { owner: 'mcp-host-list', token: 'tok-host', folders: { host: '/host' } }
const caller = { owner: 'scout', token: 'tok-caller', caller: { ORCA_AGENT_SESSION_ID: 'chat-1' } }

describe("a daemon start's kept tool grants", () => {
  it('lives exactly as long as its relay, and a revoke takes only that owner', () => {
    const kept = new DaemonToolRelayKeptGrants()
    expect(kept.keep('r-1', 'chat-1', { grants: [scout], caller })).toBe(true)
    expect(kept.keep('r-2', 'chat-2', { grants: [host, scout] })).toBe(true)

    kept.revoke('scout')
    // Chat 1 kept only scout's grant and caller, so its relay holds nothing more.
    expect(kept.holds('r-1')).toBe(false)
    expect(kept.list()).toEqual([{ relayId: 'r-2', chatKey: 'chat-2', grants: [host] }])

    kept.forget('r-2')
    expect(kept.list()).toEqual([])
  })

  it('keeps nothing from a malformed or oversized hand-over', () => {
    const kept = new DaemonToolRelayKeptGrants()
    expect(kept.keep('r-1', 'chat-1', undefined)).toBe(false)
    expect(kept.keep('r-1', 'chat-1', { grants: [{ ...scout, token: 7 }] })).toBe(false)
    expect(kept.keep('r-1', 'chat-1', { grants: Array.from({ length: 9 }, () => scout) })).toBe(
      false
    )
    expect(
      kept.keep('r-1', 'chat-1', { grants: [], caller: { ...caller, caller: { a: 1 } } })
    ).toBe(false)
    expect(kept.list()).toEqual([])
  })
})
