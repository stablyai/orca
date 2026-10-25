import { z } from 'zod'

/**
 * The one haptic the page asks the shell for, as a `notify` rather than a verb.
 *
 * Fire-and-forget on the request/reply table would be wrong twice over: a reply costs a slot in the
 * same 64-deep in-flight window a forwarded request spends, and there are 90 call sites in this
 * app, some of them one per row of a scrolling list. Nothing is owed back — a haptic the shell did
 * not play is a tap that felt like every tap on every phone before this page existed.
 *
 * Split out of `bridge-envelope.ts` rather than added to it, as `bridge-event-envelope-bytes.ts`
 * was: that file is the protocol's schemas and it is at its line cap. The arm below is its fields
 * without `v`, because the envelope owns the version literal and reading it back from here would be
 * an import cycle.
 */

/**
 * The grant, a single token rather than the notify's own name.
 *
 * The notify table's grants are tokens — `navigate`, `storage` — because a notify is not a verb:
 * `MOBILE_WEB_SHELL_GRANTS` spreads the dotted names from the verb table alone. One token is also
 * what the capability is: an app either plays haptics or it does not.
 */
export const BRIDGE_HAPTICS_GRANT = 'haptics'

/** The notify name. Dotted like a verb because it names a device the shell owns, not a screen. */
export const BRIDGE_HAPTICS_NOTIFY = 'native.haptics.trigger'

/**
 * Exactly the five haptics `src/platform/haptics.ts` has, and nothing the page can invent.
 *
 * A closed list, so a kind outside it takes the whole frame down as `unrecognised-message` on an
 * older shell; adding one is a compatibility change rather than an additive field. The shell's
 * handler is keyed on this tuple, so a kind here with no function behind it does not compile.
 */
export const BRIDGE_HAPTICS_KINDS = [
  'mediumImpact',
  'selection',
  'success',
  'error',
  'edgeBump'
] as const

export type BridgeHapticsKind = (typeof BRIDGE_HAPTICS_KINDS)[number]

/** Spread into the envelope's notify union beside `v`, which the envelope adds. */
export const BRIDGE_HAPTICS_NOTIFY_FIELDS = {
  type: z.literal('notify'),
  name: z.literal(BRIDGE_HAPTICS_NOTIFY),
  kind: z.enum(BRIDGE_HAPTICS_KINDS)
}
