/** The page's outbound notify surface: what it posts, what it stays quiet about, and what it
 *  answers when the shell granted nothing or the port refused the frame. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeClientNotReadyError } from './bridge-client-errors'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION
} from './bridge-envelope'
import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from './bridge-caps'
import {
  BRIDGE_HAPTICS_GRANT,
  BRIDGE_HAPTICS_KINDS,
  BRIDGE_HAPTICS_NOTIFY
} from './bridge-haptics-notify'
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
    expect(page.client.notifyNavigateBack()).toBe(false)
    expect(page.client.notifyExternalLink('https://example.com')).toBe(false)
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

/**
 * The second verb of one grant, which is the only reason the page can ask for it at all.
 *
 * A shell too old to know the name still granted `navigate`, so the page posts and that shell
 * refuses the whole frame as `unrecognised-message`. Nothing here can tell those two apart: the
 * caller falls back to its own router either way, which on the page goes nowhere and is exactly
 * what a Back button already did.
 */
describe('navigate-back', () => {
  it('posts under the navigate grant, with no target of its own', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate'] } })
    expect(page.client.notifyNavigateBack()).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_NAVIGATE_BACK_NOTIFY
    })
  })

  it('stays quiet against a shell that granted no navigate', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['storage'] } })
    const beforeNotify = page.sent.length
    expect(page.client.notifyNavigateBack()).toBe(false)
    expect(page.sent).toHaveLength(beforeNotify)
  })

  it('asks for no grant of its own, which no route may declare', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_NAVIGATE_BACK_NOTIFY] } })
    expect(page.client.notifyNavigateBack()).toBe(false)
  })

  it('answers false after close rather than throwing into a teardown', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate'] } })
    page.client.close()
    expect(page.client.notifyNavigateBack()).toBe(false)
  })
})

/**
 * The verb whose refusal the caller has to hear about.
 *
 * Nothing crosses back for a notify, so the boolean is the only answer a tap gets. A URL outside
 * the three schemes is refused here rather than posted and dropped at the frame, because the page
 * reporting "opened" into a frame the shell threw away is the dead tap the grant exists to rule out.
 */
describe('externalLink', () => {
  function granted(): ReturnType<typeof createPageClient> {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_GRANT] } })
    return page
  }

  it('posts an allowed URL under its own grant', () => {
    const page = granted()
    expect(page.client.notifyExternalLink('https://github.com/stablyai/orca')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_EXTERNAL_LINK_GRANT,
      url: 'https://github.com/stablyai/orca'
    })
  })

  it('posts the URL the parser read, not the string the caller handed it', () => {
    const page = granted()
    expect(page.client.notifyExternalLink('  https://example.com/a\r\n  ')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_EXTERNAL_LINK_GRANT,
      url: 'https://example.com/a'
    })
  })

  it('answers false for a scheme the grant does not cover, and posts nothing', () => {
    const page = granted()
    const beforeNotify = page.sent.length
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', '/h/host-a/tasks']) {
      expect(page.client.notifyExternalLink(url), url).toBe(false)
    }
    expect(page.sent).toHaveLength(beforeNotify)
  })

  it('stays quiet against a shell that granted no externalLink', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate', 'storage'] } })
    const beforeNotify = page.sent.length
    expect(page.client.notifyExternalLink('https://example.com')).toBe(false)
    expect(page.sent).toHaveLength(beforeNotify)
  })

  it('answers false after close rather than throwing into a teardown', () => {
    const page = granted()
    page.client.close()
    expect(page.client.notifyExternalLink('https://example.com')).toBe(false)
  })
})

/**
 * The haptic the page asks for and hears nothing back about.
 *
 * Gated at the call site as well as at the frame, for the reason every gated notify is: `notify` is
 * a closed list, so a shell that granted no haptics refuses the whole frame, and a caller told the
 * frame left would be told a lie. Unlike `externalLink` nobody reads the answer — a tap that did
 * not buzz is every tap on every phone before this page existed — so it is returned and not logged.
 */
describe('bridge client haptics', () => {
  const granted = (page: ReturnType<typeof createPageClient>): void => {
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_HAPTICS_GRANT] } })
  }

  it('posts one frame per kind, carrying the kind it was asked for', () => {
    const page = createPageClient()
    granted(page)
    for (const kind of BRIDGE_HAPTICS_KINDS) {
      expect(page.client.notifyHaptics(kind), kind).toBe(true)
    }
    expect(page.frames().slice(1)).toEqual(
      BRIDGE_HAPTICS_KINDS.map((kind) => ({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_HAPTICS_NOTIFY,
        kind
      }))
    )
  })

  it('stays quiet against a shell that granted nothing, because the frame would be refused whole', () => {
    const page = createPageClient()
    page.start()
    expect(page.client.notifyHaptics('selection')).toBe(false)
    expect(page.sent).toHaveLength(1)
  })

  it('stays quiet against a shell that granted the notify name instead of the token', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_HAPTICS_NOTIFY] } })
    expect(page.client.notifyHaptics('selection')).toBe(false)
    expect(page.sent).toHaveLength(1)
  })

  it('answers false before a session and after close rather than throwing inside a tap handler', () => {
    const early = createPageClient()
    expect(early.client.notifyHaptics('selection')).toBe(false)
    const page = createPageClient()
    granted(page)
    page.client.close()
    expect(page.client.notifyHaptics('selection')).toBe(false)
    expect(page.frames().at(-1)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
  })
})

/**
 * What a haptic costs on the wire, measured off the frame the client posted rather than a written
 * copy of its shape: the two drift, and the one that drifts is the budget.
 *
 * The worst kind is the longest name, and a scrolling list is the worst case for the count: the
 * file explorer plays `selection` once per row, so twelve rows is the number to think about.
 */
describe('the bytes a haptic spends', () => {
  it('costs well under a thousandth of the frame cap, whichever kind it is', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_HAPTICS_GRANT] } })
    const bytes = BRIDGE_HAPTICS_KINDS.map((kind) => {
      page.client.notifyHaptics(kind)
      return utf8ByteLength(page.sent.at(-1) ?? '')
    })
    // One per kind, widest first: `mediumImpact` is the longest name and `error` the shortest.
    expect(bytes).toEqual([77, 74, 72, 70, 73])
    expect(Math.max(...bytes) / BRIDGE_MAX_MESSAGE_BYTES).toBeLessThan(0.0002)
  })

  it('costs a twelve-row scroll under a kilobyte, one frame per row', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_HAPTICS_GRANT] } })
    const before = page.sent.length
    for (let row = 0; row < 12; row += 1) {
      page.client.notifyHaptics('selection')
    }
    const scroll = page.sent.slice(before)
    expect(scroll).toHaveLength(12)
    expect(scroll.reduce((total, json) => total + utf8ByteLength(json), 0)).toBe(888)
  })
})
