import { z } from 'zod'
import { BRIDGE_MAX_METHOD_CHARS } from './bridge-caps'

/**
 * What every bridge frame is keyed on: its version, its correlation id, and the grant names the
 * two halves of the envelope both spell.
 *
 * Its own module because both halves need them and neither may import the other: the page-to-shell
 * union lives in `bridge-notify-envelope.ts` and the rest in `bridge-envelope.ts`, which re-exports
 * everything here so no caller has to know where a name is declared.
 */

/**
 * Every message the page and the shell exchange, in both directions.
 *
 * `v` gates envelope shape and nothing else: capability is gated by `init.grants`, so a shell that
 * learns a new native grant never bumps it. Unknown keys are dropped rather than refused, because
 * the page bundle is served by a desktop that updates independently of the installed shell, and an
 * additive field must not take a working pair offline. The rule, in one line: `v` gates
 * incompatible shape; additive fields never bump `v`.
 *
 * A new member of a closed list is NOT an additive field. `end.reason`, `binary.format`,
 * `connection.state` and the foreground reasons are enumerated here, so a value outside the list
 * takes the whole frame down as `unrecognised-message` on the older side. Adding one is a
 * compatibility change: it has to be negotiated, the way a new opcode is, not shipped on the
 * strength of the reader dropping what it does not know.
 *
 * The two readers differ in more than their schema: the page's traffic is held to the document
 * caps, the shell's answers are not. `parseBridgeMessage` documents why.
 */
export const BRIDGE_PROTOCOL_VERSION = 1

/** Correlation ids are minted by whichever side opens the exchange; 22 chars is 128 bits of base64url. */
export const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export const versionSchema = z.literal(BRIDGE_PROTOCOL_VERSION)
export const idSchema = z.string().regex(BRIDGE_ID_PATTERN)
// Length only: the desktop's mobile-scope allowlist decides which names exist, and a charset guess
// here would refuse a method that allowlist already permits.
export const methodSchema = z.string().min(1).max(BRIDGE_MAX_METHOD_CHARS)

/** Closed against `ForegroundNudgeReason`; the pin lives in this module's test. */
export const BRIDGE_FOREGROUND_NUDGE_REASONS = ['focus', 'app-resume', 'network-change'] as const

/**
 * The one grant negotiated for the protocol itself rather than for a screen: the shell saying it
 * will act on a `fault` report.
 *
 * It exists because `notify` is a closed list on both sides. A page served by a newer desktop into
 * an older shell that posted an unknown name would have the whole frame refused as
 * `unrecognised-message`, so the page asks first and stays quiet when the answer is no.
 */
export const BRIDGE_FAULT_GRANT = 'fault'

/**
 * The `navigate` grant's second verb, and the first notify whose name is not its grant's.
 *
 * The page is served at `/` with one history entry written by `replaceState`, so its own Back goes
 * nowhere: the only stack to pop is the native one the shell pushed the page onto. It rides
 * `navigate` rather than a name of its own because an app that can open a screen can close one, and
 * a new grant name would leave every route that declares it native on every shell already shipped.
 */
export const BRIDGE_NAVIGATE_BACK_NOTIFY = 'navigate-back'

/**
 * The grant a page needs before the shell will open anything outside it.
 *
 * Its own name rather than a verb of `navigate`, because it is a different capability: `navigate`
 * opens a screen this app carries, and this hands a URL to whatever the device opens it with. A
 * shell that implements one and not the other is a real shell, and the route policy has to be able
 * to say so.
 */
export const BRIDGE_EXTERNAL_LINK_GRANT = 'externalLink'
