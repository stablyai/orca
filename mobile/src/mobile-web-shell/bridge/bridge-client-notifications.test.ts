/** The page's outbound notify surface: what it posts, what it stays quiet about, and what it
 *  answers when the shell granted nothing or the port refused the frame. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeClientNotReadyError } from './bridge-client-errors'
import { BRIDGE_FAULT_GRANT, BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { GRANTS, INIT, createPageClient } from './bridge-page-client-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge client page faults', () => {
  /** A shell that says it will act on a fault, which is the only kind the page posts one to. */
  function startGranted(page: ReturnType<typeof createPageClient>): void {
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_FAULT_GRANT] } })
  }

  it('posts the captured error once the shell has granted fault reporting', () => {
    const page = createPageClient()
    startGranted(page)
    expect(page.client.notifyPageFault(new Error('the route threw'))).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_FAULT_GRANT,
      error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
    })
  })

  it('stays quiet against a shell that granted nothing, because the frame would be refused whole', () => {
    const page = createPageClient()
    page.start()
    expect(page.client.notifyPageFault(new Error('the route threw'))).toBe(false)
    expect(page.sent).toHaveLength(1)
  })

  it('answers false before a session and after close rather than throwing at a boundary', () => {
    const early = createPageClient()
    expect(early.client.notifyPageFault(new Error('too soon'))).toBe(false)
    const page = createPageClient()
    startGranted(page)
    page.client.close()
    expect(page.client.notifyPageFault(new Error('too late'))).toBe(false)
    expect(page.frames().at(-1)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
  })

  it('answers false for a port that refused the frame, and reports it once', () => {
    const page = createPageClient({
      send: () => {
        throw new Error('the channel is gone')
      }
    })
    startGranted(page)
    expect(page.client.notifyPageFault(new Error('the route threw'))).toBe(false)
    expect(page.diagnostics.map((diagnostic) => diagnostic.kind)).toContain('send-failed')
  })
})

/**
 * Which notifies reach the mount-order throw, pinned because the grant check is what decides it.
 *
 * A grant is read off the session, so before `init` there is no grant either and the two gated
 * notifies answer false without ever asking for the session. That is the answer their callers
 * already handle, and it must stay the answer: `useRouteHandoff` calls `notifyNavigate` uncaught
 * inside `push`, where a throw would take down a tap handler nobody wrapped.
 */
describe('the notify guard before init', () => {
  it('answers false for the grant-gated notifies and posts nothing', () => {
    const page = createPageClient()
    // Against what the handshake already put on the port, so this counts the notifies alone.
    const beforeNotifies = page.sent.length
    expect(page.client.notifyNavigate('/h/host-1')).toBe(false)
    expect(page.client.notifyStorageWrite('orca:last-visited-worktree', 'value')).toBe(false)
    expect(page.sent).toHaveLength(beforeNotifies)
  })

  it('still throws for the ungated ones, which is the mount-order bug the guard is for', () => {
    const page = createPageClient()
    expect(() => page.client.notifyForeground()).toThrow(BridgeClientNotReadyError)
    expect(() =>
      page.client.updateTerminalSubscriptionViewport('terminal-1', { cols: 80, rows: 24 })
    ).toThrow(BridgeClientNotReadyError)
  })

  it('posts the gated ones once the shell has granted them', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate', 'storage'] } })
    expect(page.client.notifyNavigate('/h/host-1')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: 'navigate',
      href: '/h/host-1'
    })
  })
})
