import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DAEMON_QUERY_RESPONDER_CONFIRM_TIMEOUT_MS,
  DaemonQueryResponderDelegation,
  type DaemonQueryResponderDelegationHost
} from './daemon-query-responder-delegation'

const PTY = 'pty-1'

function createDelegation() {
  const state = {
    hidden: new Set<string>(),
    eligible: true,
    sendOk: true,
    generation: 1,
    caughtUp: true,
    sent: new Array<[string, boolean]>(),
    requested: new Map<string, boolean>(),
    reclaimed: new Array<string>()
  }
  const host: DaemonQueryResponderDelegationHost = {
    lifecycleGeneration: () => state.generation,
    isHidden: (id) => state.hidden.has(id),
    shouldDelegate: (id) => state.eligible && state.hidden.has(id),
    send: (id, responder) => {
      if (state.sendOk) {
        state.sent.push([id, responder])
      }
      return state.sendOk
    },
    setHandoffPending: (id, pending) => state.requested.set(id, pending),
    reclaim: (id) => {
      state.reclaimed.push(id)
      return state.caughtUp
    }
  }
  return { state, delegation: new DaemonQueryResponderDelegation(host) }
}

describe('DaemonQueryResponderDelegation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delegates a hidden eligible PTY once and ignores visible ones', () => {
    const { state, delegation } = createDelegation()
    delegation.sync(PTY)
    expect(state.sent).toEqual([])

    state.hidden.add(PTY)
    delegation.sync(PTY)
    delegation.sync(PTY)
    expect(state.sent).toEqual([[PTY, true]])
    expect(state.requested.get(PTY)).toBe(true)
    expect(delegation.isRequested(PTY)).toBe(true)
  })

  it('takes replies back on reveal without waking main, and wakes it when hidden', () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    delegation.sync(PTY)
    delegation.noteMarker(PTY, true)

    state.hidden.delete(PTY)
    delegation.sync(PTY)
    expect(state.sent).toEqual([
      [PTY, true],
      [PTY, false]
    ])
    expect(state.requested.get(PTY)).toBe(false)
    expect(state.reclaimed).toEqual([])

    state.hidden.add(PTY)
    delegation.sync(PTY)
    state.eligible = false
    delegation.sync(PTY)
    expect(state.sent.at(-1)).toEqual([PTY, false])
    expect(state.reclaimed).toEqual([PTY])
  })

  it('gives up on an unconfirmed request, reclaims, and waits for the next generation', () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    delegation.sync(PTY)

    vi.advanceTimersByTime(DAEMON_QUERY_RESPONDER_CONFIRM_TIMEOUT_MS)
    expect(state.requested.get(PTY)).toBe(false)
    expect(state.reclaimed).toEqual([PTY])
    expect(state.sent).toEqual([
      [PTY, true],
      [PTY, false]
    ])

    // A confirmation arriving after the give-up needs no second take-back: one is in flight.
    delegation.noteMarker(PTY, true)
    delegation.sync(PTY)
    expect(state.sent).toHaveLength(2)

    state.generation = 2
    delegation.sync(PTY)
    expect(state.sent.at(-1)).toEqual([PTY, true])
  })

  it('does not time out once the daemon confirmed', () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    delegation.sync(PTY)
    delegation.noteMarker(PTY, true)
    vi.advanceTimersByTime(DAEMON_QUERY_RESPONDER_CONFIRM_TIMEOUT_MS * 2)
    expect(state.requested.get(PTY)).toBe(true)
    expect(state.reclaimed).toEqual([])
  })

  it('asks again when the daemon dropped a confirmed delegation on its own', () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    delegation.sync(PTY)
    delegation.noteMarker(PTY, true)

    delegation.noteMarker(PTY, false)
    expect(state.sent).toEqual([
      [PTY, true],
      [PTY, true]
    ])
    expect(state.reclaimed).toEqual([])
    expect(state.requested.get(PTY)).toBe(true)
  })

  it('takes back a confirmation main no longer wants', () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    delegation.sync(PTY)
    state.hidden.delete(PTY)
    delegation.sync(PTY)
    // Both markers are owed; the first must not trigger a third request.
    delegation.noteMarker(PTY, true)
    delegation.noteMarker(PTY, false)
    expect(state.sent).toEqual([
      [PTY, true],
      [PTY, false]
    ])

    delegation.noteMarker('pty-unknown', true)
    expect(state.sent.at(-1)).toEqual(['pty-unknown', false])
  })

  it('stays with main when the request cannot be sent', () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    state.sendOk = false
    delegation.sync(PTY)
    state.sendOk = true
    delegation.sync(PTY)
    expect(state.sent).toEqual([])
    expect(state.requested.has(PTY)).toBe(false)
  })

  it("keeps the daemon answering a hidden PTY until main's woken model has caught up", () => {
    const { state, delegation } = createDelegation()
    state.hidden.add(PTY)
    delegation.sync(PTY)
    delegation.noteMarker(PTY, true)
    state.eligible = false
    state.caughtUp = false

    delegation.sync(PTY)
    delegation.sync(PTY)
    expect(state.sent).toEqual([[PTY, true]])
    expect(state.reclaimed).toEqual([PTY, PTY])
    expect(state.requested.get(PTY)).toBe(true)

    state.caughtUp = true
    delegation.sync(PTY)
    expect(state.sent).toEqual([
      [PTY, true],
      [PTY, false]
    ])
  })
})
