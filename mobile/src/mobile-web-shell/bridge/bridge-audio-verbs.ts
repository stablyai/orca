import { z } from 'zod'
import { MAX_DICTATION_AUDIO_CHUNK_BYTES } from '../../../../src/shared/rpc-contract/speech-params'

// The shell owns microphone PCM and its wake lock; the page owns dictation state/RPCs. Pull from the ring through existing request/reply rather than adding a push frame.
// Keep verb grant segments lowercase: a camel-cased audio.readChunk would fail manifest grammar and reject the whole bundle.

// A full ring drain goes to the host as one chunk, so stay within its chunk cap; shipped shells validate maxBytes against this.
export const BRIDGE_AUDIO_RING_MAX_BYTES = MAX_DICTATION_AUDIO_CHUNK_BYTES

// Base64 uses four chars per three bytes; a full ring drain fits the message cap.
export const BRIDGE_AUDIO_READ_MAX_BASE64_CHARS = Math.ceil(BRIDGE_AUDIO_RING_MAX_BYTES / 3) * 4

// Accept the device’s actual rate when it cannot open the requested 16 kHz; the page must forward that rate to desktop.
export const BRIDGE_AUDIO_MIN_SAMPLE_RATE = 8_000
export const BRIDGE_AUDIO_MAX_SAMPLE_RATE = 48_000

// Return denied permission as start data so the page offers Settings rather than a transport fault; retain undetermined for OS answers outside the prompting path.
export const BRIDGE_AUDIO_PERMISSIONS = ['granted', 'denied', 'undetermined'] as const

export type BridgeAudioPermission = (typeof BRIDGE_AUDIO_PERMISSIONS)[number]

// Return interruptions with the existing 500 ms read poll rather than a new verb/push lane; the page applies the native interruption state.
export const BRIDGE_AUDIO_INTERRUPTIONS = ['began', 'ended', 'blocked'] as const

export type BridgeAudioInterruption = (typeof BRIDGE_AUDIO_INTERRUPTIONS)[number]

// began/blocked end capture, while ended returns the audio session after events such as a chime. Share this rule across shell/native/page to prevent drift; unknown engine strings are not actionable interruptions.
export function bridgeAudioInterruptionEndsCapture(kind: string): boolean {
  return kind === 'began' || kind === 'blocked'
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

const sampleRateSchema = z
  .number()
  .int()
  .min(BRIDGE_AUDIO_MIN_SAMPLE_RATE)
  .max(BRIDGE_AUDIO_MAX_SAMPLE_RATE)

// Reject extra params: independently updated page/shell builds must not silently accept a changed verb by stripping fields.
export const audioStartParamsSchema = z.strictObject({ sampleRate: sampleRateSchema })

// Keep started and permission separate: denied access needs Settings, while a granted microphone that fails to open is a device fault.
export const audioStartResultSchema = z.strictObject({
  started: z.boolean(),
  sampleRate: sampleRateSchema,
  permission: z.enum(BRIDGE_AUDIO_PERMISSIONS)
})

export const audioReadParamsSchema = z.strictObject({
  maxBytes: z.number().int().min(1).max(BRIDGE_AUDIO_RING_MAX_BYTES)
})

// Clear droppedBytes after each read so the page reports each loss once as connection-slow. recording reflects shell state; drain final bytes after OS stop rather than polling forever.
export const audioReadResultSchema = z.strictObject({
  base64: z.string().max(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS).regex(BASE64_PATTERN),
  droppedBytes: z.number().int().nonnegative(),
  recording: z.boolean(),
  interruption: z.enum(BRIDGE_AUDIO_INTERRUPTIONS).nullable()
})

export type BridgeAudioChunk = z.infer<typeof audioReadResultSchema>

export const audioStopParamsSchema = z.strictObject({})

// stopped:false is a normal repeated/interrupted stop. Return the ring tail with stop so the page cannot race a final read against shutdown.
// Default both tail fields for older shells that answer stopped alone; missing audio may lose a tail but must not reject the stop.
export const audioStopResultSchema = z.strictObject({
  stopped: z.boolean(),
  base64: z.string().max(BRIDGE_AUDIO_READ_MAX_BASE64_CHARS).regex(BASE64_PATTERN).default(''),
  droppedBytes: z.number().int().nonnegative().default(0)
})
