import { describe, expect, it } from 'vitest'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY
} from './bridge-envelope'
import { BRIDGE_HAPTICS_GRANT, BRIDGE_HAPTICS_NOTIFY } from './bridge-haptics-notify'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { bridgeNotifyRefusal, type BridgeNotifyName } from './bridge-notify-grants'

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

/**
 * Haptics, the first notify added since the protocol's own, and the second whose name is not its
 * grant: `native.haptics.trigger` rides the single token `haptics`.
 *
 * A token because a notify is not a verb: every grant in that table is one, and the dotted names
 * `MOBILE_WEB_SHELL_GRANTS` carries are spread from the verb table. A route declaring the notify's
 * own name would be declaring something no shell advertises, which the case below pins.
 */
describe('the haptics notify', () => {
  it('is refused on a route that was granted no haptics', () => {
    expect(bridgeNotifyRefusal({ name: BRIDGE_HAPTICS_NOTIFY, initSent: true, granted: [] })).toBe(
      'ungranted'
    )
    // Granted everything else this shell has, so the refusal is the haptics row and not an
    // empty list.
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_HAPTICS_NOTIFY,
        initSent: true,
        granted: ['navigate', 'storage', BRIDGE_EXTERNAL_LINK_GRANT, BRIDGE_FAULT_GRANT]
      })
    ).toBe('ungranted')
  })

  it('is served on a route that was granted the token', () => {
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_HAPTICS_NOTIFY,
        initSent: true,
        granted: [BRIDGE_HAPTICS_GRANT]
      })
    ).toBeNull()
  })

  it('is not served against a grant list that names the notify instead of the token', () => {
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_HAPTICS_NOTIFY,
        initSent: true,
        granted: [BRIDGE_HAPTICS_NOTIFY]
      })
    ).toBe('ungranted')
  })

  it('is refused before a grant is read at all from a page with no session', () => {
    expect(
      bridgeNotifyRefusal({
        name: BRIDGE_HAPTICS_NOTIFY,
        initSent: false,
        granted: [BRIDGE_HAPTICS_GRANT]
      })
    ).toBe('before-ready')
  })
})

/**
 * The totality shown rather than described.
 *
 * The docstring above says a name with no row is a compile error; this is the error. Every row the
 * table has, less the haptics one, against the same `Record` over the union — checked by
 * `tsconfig.test.json`, so the day the omission stops being an error the unused directive is.
 */
describe('a grant table missing a row', () => {
  it('does not typecheck', () => {
    // @ts-expect-error TS2741: no row for the haptics notify, the hole the Record closes.
    const incomplete: Readonly<Record<BridgeNotifyName, string | null>> = {
      foreground: null,
      terminalViewport: null,
      navigate: 'navigate',
      [BRIDGE_NAVIGATE_BACK_NOTIFY]: 'navigate',
      storage: 'storage',
      [BRIDGE_EXTERNAL_LINK_GRANT]: BRIDGE_EXTERNAL_LINK_GRANT,
      [BRIDGE_FAULT_GRANT]: BRIDGE_FAULT_GRANT
    }
    expect(Object.keys(incomplete)).toHaveLength(7)
  })
})

/**
 * The page reporting on its own document.
 *
 * Ungranted for the same reason the param clear is: nothing here reaches the host or the device,
 * and the shell acts on it only for a page whose `ready` declared it. It is still refused before
 * `init`, because a frame from a document nothing has answered is not this document's word.
 */
describe('the page reporting its first frame', () => {
  it('needs no grant once the session is open', () => {
    expect(
      bridgeNotifyRefusal({ name: BRIDGE_PAGE_PAINTED, initSent: true, granted: [] })
    ).toBeNull()
  })

  it('is refused before the page has been told anything', () => {
    expect(
      bridgeNotifyRefusal({ name: BRIDGE_PAGE_PAINTED, initSent: false, granted: GRANTED })
    ).toBe('before-ready')
  })
})
