import { z } from 'zod'
import { MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES } from '../../hooks/mobile-dictation-pending-audio-budget'

/**
 * The wire shapes of `native.audio.start`, `native.audio.read` and `native.audio.stop`.
 *
 * Dictation is the page's, and the microphone is the shell's. The page holds the state machine the
 * composer renders and speaks `speech.dictation.*` to the desktop, so the only thing that has to
 * cross is the capability: raw PCM. The screen the microphone holds awake does not cross at all —
 * it is a property of the capture, taken and given back on the device side. That is why audio is
 * pulled rather than pushed. The `request`/`reply` table is the only page-facing seam the shell
 * has, the one shell-to-page push there is belongs to an RPC `subscribe`, and a push lane for bytes
 * the page immediately hands back would be a new frame kind for no gain.
 *
 * So the shell rings what the microphone produces and the page drains it. The ring is exactly the
 * page's own pending-audio budget: the page already refuses to hold more unsent audio than that,
 * so a second, different bound would be a second answer to the same question.
 *
 * The verbs are `audio.start|read|stop`, never `audio.readChunk`: a manifest grant name is held to
 * `native(?:\.[a-z][a-z0-9]*){2,}` by `GRANT_NAME_PATTERN`, and `bundled-mobile-web-bundle.ts`
 * parses the manifest whole, so one camel-cased segment is a bundle the phone refuses entire.
 */

/**
 * What the shell holds for a page that has not drained, in raw PCM bytes.
 *
 * Derived from the page's budget rather than written down beside it: `use-mobile-dictation.ts`
 * already refuses to hold more than this in unsent audio and fails the dictation with
 * `MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE` when it would. Two numbers that must agree are
 * one that drifts, and a ring larger than the budget would hand the page bytes it will throw away.
 */
export const BRIDGE_AUDIO_RING_MAX_BYTES = MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES

/** Whole base64 groups of the ring: four characters encode three bytes, so a full drain is exactly
 *  this many characters and never one more. A drain of the whole ring is 213,336 characters, which
 *  is a third of `BRIDGE_MAX_MESSAGE_BYTES` — so the largest read there can be still fits a frame. */
export const BRIDGE_AUDIO_READ_MAX_BASE64_CHARS = Math.ceil(BRIDGE_AUDIO_RING_MAX_BYTES / 3) * 4

/**
 * The rates a capture may run at.
 *
 * Wide rather than pinned to the 16 kHz the desktop transcribes at, because the device is what
 * decides: an engine that will not open at the asked-for rate answers the rate it opened at, and a
 * page that pinned one value here could not carry that answer back.
 */
export const BRIDGE_AUDIO_MIN_SAMPLE_RATE = 8_000
export const BRIDGE_AUDIO_MAX_SAMPLE_RATE = 48_000

/**
 * What the OS said about the microphone, as data rather than as a rejection.
 *
 * A denied microphone is the answer to `start`, not a fault in it: the page renders "permission
 * denied" as a state the user can act on, and a rejection would reach the same screen as a shell
 * that could not be talked to at all. `undetermined` is the arm that cannot be reached through a
 * shell that prompts — the prompt is the shell's, inside `start`, as ruling 6b settled for `pick` —
 * and is kept because an OS that answers neither still has to be describable.
 */
export const BRIDGE_AUDIO_PERMISSIONS = ['granted', 'denied', 'undetermined'] as const

export type BridgeAudioPermission = (typeof BRIDGE_AUDIO_PERMISSIONS)[number]

/**
 * What the OS did to a capture that was running, in the vocabulary the native engines already emit.
 *
 * It rides the `read` reply rather than a fifth verb or a push: the page is already asking every
 * 500 ms, so the longest an interruption can go unseen is that interval, and a page that heard it
 * reaches exactly the state `onAudioInterruption` reaches natively.
 */
export const BRIDGE_AUDIO_INTERRUPTIONS = ['began', 'ended', 'blocked'] as const

export type BridgeAudioInterruption = (typeof BRIDGE_AUDIO_INTERRUPTIONS)[number]

/**
 * Whether an interruption is the OS taking the capture away, rather than handing it back.
 *
 * `began` and `blocked` end it; `ended` on its own does not — that is the OS returning the session
 * after, say, a notification chime, and a dictation that cancelled on it would end itself the
 * moment the chime finished. One predicate because three places decide it: the shell, which stops
 * filling its ring; the native seam, which raises it off `onAudioInterruption`; and the page, which
 * raises it off a `read` reply. Two of them had drifted apart.
 *
 * Takes a string rather than the union, because the native engines hand over whatever they emit and
 * a kind this build has no name for is not an interruption it can describe.
 */
export function bridgeAudioInterruptionEndsCapture(kind: string): boolean {
  return kind === 'began' || kind === 'blocked'
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

const sampleRateSchema = z
  .number()
  .int()
  .min(BRIDGE_AUDIO_MIN_SAMPLE_RATE)
  .max(BRIDGE_AUDIO_MAX_SAMPLE_RATE)

// Strict, not stripping, for the reason every other verb's params are: the page and the shell are
// separate builds, and a param the shell silently drops is the shape of a verb that changed under
// a page that thought it had asked for something.
export const audioStartParamsSchema = z.strictObject({ sampleRate: sampleRateSchema })

/**
 * `started` and `permission` both, because they answer different questions.
 *
 * A denied microphone is `started: false, permission: 'denied'`; an engine that would not open on a
 * granted microphone is `started: false, permission: 'granted'`. A page that had only the boolean
 * would send the user to Settings for a device fault, and one that had only the permission would
 * sit in `recording` with no microphone behind it.
 */
export const audioStartResultSchema = z.strictObject({
  started: z.boolean(),
  sampleRate: sampleRateSchema,
  permission: z.enum(BRIDGE_AUDIO_PERMISSIONS)
})

export const audioReadParamsSchema = z.strictObject({
  maxBytes: z.number().int().min(1).max(BRIDGE_AUDIO_RING_MAX_BYTES)
})

/**
 * One drain of the ring: the bytes, what the ring could not hold, and whether it is still filling.
 *
 * `droppedBytes` is what the page acts on rather than a diagnostic. The ring is the page's own
 * budget, so a drop means the page is not draining as fast as the microphone fills — which is the
 * `MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE` state the composer already renders. Counted
 * since the previous read and cleared by it, so two reads never report the same dropped byte twice.
 *
 * `recording` is the shell's own state and not an echo of the page's: a capture the OS took away
 * answers `false` with the last bytes still in the ring, so a page drains what it has and then
 * stops rather than reading an empty ring forever.
 */
export const audioReadResultSchema = z.strictObject({
  base64: z.string().max(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS).regex(BASE64_PATTERN),
  droppedBytes: z.number().int().nonnegative(),
  recording: z.boolean(),
  interruption: z.enum(BRIDGE_AUDIO_INTERRUPTIONS).nullable()
})

export type BridgeAudioChunk = z.infer<typeof audioReadResultSchema>

/** No params: there is one capture per page session, so there is nothing to name. */
export const audioStopParamsSchema = z.strictObject({})

/**
 * The stop, and the tail it takes with it.
 *
 * `stopped` is false for a session that was not capturing, which is not a fault: a page that stops
 * twice, or stops after an interruption already ended the capture, asked for the state it already
 * has.
 *
 * The bytes are whatever the ring still held — up to one drain interval of what the user was still
 * saying as they lifted the button, which no timer is coming for. Carried by the stop rather than
 * fetched by a last read, because a page that has to read before it stops has an ordering to get
 * right and a re-entry to guard; a reply that brings the tail with it has neither.
 *
 * Both tail fields default rather than being required. The page updates over the air and the shell
 * does not, so a page this new can be talking to a shell that answers `stopped` alone: absent, that
 * dictation loses its tail, where a required field would have lost it the stop itself.
 */
export const audioStopResultSchema = z.strictObject({
  stopped: z.boolean(),
  base64: z.string().max(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS).regex(BASE64_PATTERN).default(''),
  droppedBytes: z.number().int().nonnegative().default(0)
})
