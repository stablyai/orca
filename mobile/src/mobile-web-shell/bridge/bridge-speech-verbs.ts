import * as z from 'zod'

// On-device recognition runs in the shell, which feeds it the microphone it already owns; the page keeps the PCM it drains so a failure can replay it to the computer.
// One verb with an action keeps the session route within the grant ceiling. The page polls read on its audio drain tick because the bridge has no push lane.
export const BRIDGE_SPEECH_VERB = 'native.speech.act'

export const BRIDGE_SPEECH_STATUSES = [
  'ready',
  'needs-download',
  'downloading',
  'unsupported'
] as const

export type BridgeSpeechStatus = (typeof BRIDGE_SPEECH_STATUSES)[number]

// Every code sends the page to the computer; keep them coarse so a newer engine cannot invent one a shipped page rejects.
export const BRIDGE_SPEECH_FAILURES = [
  'unsupported',
  'needs-download',
  'permission-denied',
  'busy',
  'failed'
] as const

export type BridgeSpeechFailure = (typeof BRIDGE_SPEECH_FAILURES)[number]

const localeSchema = z.string().min(1).max(35)

const statusParamsSchema = z.strictObject({ action: z.literal('status'), locale: localeSchema })
// Starts an asset download; the page watches progress through status.
const downloadParamsSchema = z.strictObject({ action: z.literal('download'), locale: localeSchema })
// Arm before native.audio.start so the recognizer hears the first word; the shell feeds it every captured sample from then on.
const startParamsSchema = z.strictObject({ action: z.literal('start'), locale: localeSchema })
const readParamsSchema = z.strictObject({ action: z.literal('read') })
const finishParamsSchema = z.strictObject({ action: z.literal('finish') })
const cancelParamsSchema = z.strictObject({ action: z.literal('cancel') })

export const speechParamsSchema = z.discriminatedUnion('action', [
  statusParamsSchema,
  downloadParamsSchema,
  startParamsSchema,
  readParamsSchema,
  finishParamsSchema,
  cancelParamsSchema
])

export type BridgeSpeechParams = z.infer<typeof speechParamsSchema>

const textSchema = z.string().max(64_000)

// progress is 0..1 only while downloading.
export const speechStatusResultSchema = z.strictObject({
  status: z.enum(BRIDGE_SPEECH_STATUSES),
  locale: localeSchema.nullable(),
  progress: z.number().min(0).max(1).nullable()
})

export const speechDownloadResultSchema = z.strictObject({ downloading: z.boolean() })

export const speechStartResultSchema = z.strictObject({
  started: z.boolean(),
  locale: localeSchema.nullable(),
  reason: z.enum(BRIDGE_SPEECH_FAILURES).nullable()
})

// Same {revision, committed, tentative} shape the computer's chunk replies grow, so one transcript-so-far owner reads both.
// failure is set once the live session died; the page then replays its kept audio to the computer.
export const speechReadResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  committed: textSchema,
  tentative: textSchema,
  failure: z.enum(BRIDGE_SPEECH_FAILURES).nullable()
})

export const speechFinishResultSchema = z.strictObject({
  text: textSchema.nullable(),
  failure: z.enum(BRIDGE_SPEECH_FAILURES).nullable()
})

export const speechCancelResultSchema = z.strictObject({})

export type BridgeSpeechStatusResult = z.infer<typeof speechStatusResultSchema>
export type BridgeSpeechStartResult = z.infer<typeof speechStartResultSchema>
export type BridgeSpeechRead = z.infer<typeof speechReadResultSchema>
export type BridgeSpeechFinish = z.infer<typeof speechFinishResultSchema>

// The verb table validates the shell's reply against any action's shape; the page re-parses with the action's own.
export const speechResultSchema = z.union([
  speechStatusResultSchema,
  speechDownloadResultSchema,
  speechStartResultSchema,
  speechReadResultSchema,
  speechFinishResultSchema,
  speechCancelResultSchema
])
