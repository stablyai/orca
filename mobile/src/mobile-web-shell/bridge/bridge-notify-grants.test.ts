import { describe, expect, it } from 'vitest'
import { BRIDGE_FAULT_GRANT, BRIDGE_NAVIGATE_BACK_NOTIFY } from './bridge-envelope'
import { bridgeNotifyRefusal } from './bridge-notify-grants'

const GRANTED = [BRIDGE_FAULT_GRANT]

describe('what the host will act on', () => {
  it('refuses every name from a page that has not been told anything', () => {
    for (const name of [BRIDGE_FAULT_GRANT, 'foreground', 'terminalViewport'] as const) {
      expect(bridgeNotifyRefusal({ name, initSent: false, granted: GRANTED }), name).toBe(
        'before-ready'
      )
    }
  })

  it('refuses a gated name this host did not issue', () => {
    // Unreachable while every page is offered `fault`, and the whole point of the check once a
    // grant is per-route: a page on a screen that was granted nothing must not be served one.
    expect(bridgeNotifyRefusal({ name: BRIDGE_FAULT_GRANT, initSent: true, granted: [] })).toBe(
      'ungranted'
    )
  })

  it('serves a gated name this host did issue', () => {
    expect(
      bridgeNotifyRefusal({ name: BRIDGE_FAULT_GRANT, initSent: true, granted: GRANTED })
    ).toBeNull()
  })

  it("serves the protocol's own names against a page that holds no grant at all", () => {
    // `foreground` and the viewport are not grants and must not become ones by being in this file.
    for (const name of ['foreground', 'terminalViewport'] as const) {
      expect(bridgeNotifyRefusal({ name, initSent: true, granted: [] }), name).toBeNull()
    }
  })
})

/**
 * The first notify whose name is not its grant.
 *
 * `navigate-back` is the second verb of `navigate`, so nothing new enters
 * `MOBILE_WEB_SHELL_GRANTS` and an app that can open a screen can close one. A gate keyed on the
 * notify name instead would refuse it against every shell that exists.
 */
describe('a notify that rides a grant of another name', () => {
  it('is served by a host that issued navigate, and refused by one that did not', () => {
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_NAVIGATE_BACK_NOTIFY,
        initSent: true,
        granted: ['navigate']
      })
    ).toBeNull()
    expect(
      bridgeNotifyRefusal({ name: BRIDGE_NAVIGATE_BACK_NOTIFY, initSent: true, granted: [] })
    ).toBe('ungranted')
  })

  it('is not served by a host that issued the notify name itself', () => {
    // A grant list carrying `navigate-back` is a shell that named something no route may declare.
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_NAVIGATE_BACK_NOTIFY,
        initSent: true,
        granted: [BRIDGE_NAVIGATE_BACK_NOTIFY]
      })
    ).toBe('ungranted')
  })

  it('is refused before the grant is read at all from a page with no session', () => {
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_NAVIGATE_BACK_NOTIFY,
        initSent: false,
        granted: ['navigate']
      })
    ).toBe('before-ready')
  })
})

/**
 * Every gated name rides a grant, and the table that says so is total over the union.
 *
 * Keyed on the notify names themselves, a name with no row reads as ungated and the host acts on a
 * frame it never granted. The type is what rules that out — a new member of the envelope's notify
 * union without a row here is a compile error on the table — and these cases pin the rows it has.
 */
describe('the grant table', () => {
  it('holds navigate and storage to their own grants, not just navigate-back', () => {
    expect(bridgeNotifyRefusal({ name: 'navigate', initSent: true, granted: [] })).toBe('ungranted')
    expect(bridgeNotifyRefusal({ name: 'storage', initSent: true, granted: [] })).toBe('ungranted')
    expect(
      bridgeNotifyRefusal({ name: 'navigate', initSent: true, granted: ['navigate'] })
    ).toBeNull()
    expect(
      bridgeNotifyRefusal({ name: 'storage', initSent: true, granted: ['storage'] })
    ).toBeNull()
  })
})
