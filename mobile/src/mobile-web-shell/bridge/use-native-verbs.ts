import { useMemo } from 'react'
import { z } from 'zod'
import { usePageBridgeClient } from '../../transport/client-context.web'
import {
  mediaNameResultSchema,
  mediaPickResultSchema,
  mediaReadResultSchema,
  mediaReleaseResultSchema,
  type BridgeMediaChunk,
  type BridgeMediaItem,
  type BridgeMediaSource
} from './bridge-media-verbs'
import {
  audioReadResultSchema,
  audioStartResultSchema,
  audioStopResultSchema,
  type BridgeAudioChunk
} from './bridge-audio-verbs'
import {
  clipboardReadResultSchema,
  clipboardWriteResultSchema,
  type BridgeClipboardMime,
  type BridgeNativeVerb
} from './bridge-native-verbs'

// Use ordinary request frames/caps, served only on-device. Refuse ungranted verbs before posting and parse results because the installed shell can differ from this page build.
export type NativeVerbs = {
  granted: boolean
  // Check clipboard grants per verb; a read-only route must not appear unable to read because the combined read/write flag is false.
  canWriteClipboardText: boolean
  canReadClipboardText: boolean
  // Require pick/read/release together; swallowed release refusal would retain every staged file until TTL and exhaust eight handles. Clipboard image availability uses the same complete path.
  canPickMedia: boolean
  canNameMedia: boolean
  writeClipboardText: (value: string) => Promise<boolean>
  readClipboardText: () => Promise<string>
  pickMedia: (source: BridgeMediaSource, multiple: boolean) => Promise<readonly BridgeMediaItem[]>
  readMedia: (handle: string, offset: number, length: number) => Promise<BridgeMediaChunk>
  releaseMedia: (handle: string) => Promise<boolean>
  nameMedia: (handle: string) => Promise<string | null>
  startAudio: (sampleRate: number) => Promise<z.infer<typeof audioStartResultSchema>>
  readAudio: (maxBytes: number) => Promise<BridgeAudioChunk>
  // Stop carries final ring audio; stopped:false is normal after a repeated stop or an OS-ended capture.
  stopAudio: () => Promise<z.infer<typeof audioStopResultSchema>>
}

// Expose stable reason codes, including local ungranted and frame refusals. Unknown newer-shell codes floor to unreported so caller switches remain exhaustive.
// Messages are display copy, never a contract, and handler-private text never crosses.
export class NativeVerbError extends Error {
  readonly reason: NativeVerbReason

  constructor(reason: NativeVerbReason, message: string) {
    super(message)
    this.name = 'NativeVerbError'
    this.reason = reason
  }
}

// Parse arbitrary rejection code into its checked shape; Error itself declares no code property.
const shellCodedErrorSchema = z.object({ code: z.string() })

export const NATIVE_VERB_REASONS = [
  'ungranted',
  'native_verb_unknown',
  'native_verb_ungranted',
  'native_verb_params',
  'native_verb_result',
  'native_verb_out_of_scope',
  'native_verb_failed',
  'native_media_handle_unknown',
  'native_media_range',
  'native_media_handle_cap',
  'native_media_too_large',
  'native_media_permission_denied',
  'native_verb_not_a_stream',
  'native_audio_not_capturing',
  'native_verb_not_a_verb',
  'bridge_cap_exceeded',
  'bridge_host_disposed',
  'reply-too-large',
  'unreported'
] as const

export type NativeVerbReason = (typeof NATIVE_VERB_REASONS)[number]

const reasonSchema = z.enum(NATIVE_VERB_REASONS)

// Floor unknown newer-shell codes rather than let exhaustive caller switches fall off the end.
function nativeVerbReason(error: unknown): NativeVerbReason {
  const coded = shellCodedErrorSchema.safeParse(error)
  if (!coded.success) {
    return 'unreported'
  }
  const known = reasonSchema.safeParse(coded.data.code)
  return known.success ? known.data : 'unreported'
}

export function useNativeVerbs(): NativeVerbs {
  const client = usePageBridgeClient()

  return useMemo<NativeVerbs>(() => {
    const has = (verb: string): boolean =>
      client.getShellSession()?.grants.native.includes(verb) === true

    // Parse with the verb schema inside this catch; caller-side parsing would leak bare ZodError outside the promised refusal shape.
    async function call<Value>(
      verb: BridgeNativeVerb,
      params: unknown,
      result: z.ZodType<Value>
    ): Promise<Value> {
      if (!has(verb)) {
        throw new NativeVerbError('ungranted', `this shell did not grant ${verb}`)
      }
      try {
        const reply = await client.callNativeVerb(verb, params)
        return result.parse(reply.result)
      } catch (error) {
        throw error instanceof NativeVerbError
          ? error
          : new NativeVerbError(
              nativeVerbReason(error),
              error instanceof Error ? error.message : `${verb} failed`
            )
      }
    }

    const mime: BridgeClipboardMime = 'text'
    const canWriteClipboardText = has('native.clipboard.write')
    const canReadClipboardText = has('native.clipboard.read')
    return {
      granted: canWriteClipboardText && canReadClipboardText,
      canWriteClipboardText,
      canReadClipboardText,
      canPickMedia:
        has('native.media.pick') && has('native.media.read') && has('native.media.release'),
      canNameMedia: has('native.media.name'),
      writeClipboardText: async (value) =>
        (await call('native.clipboard.write', { mime, value }, clipboardWriteResultSchema)).written,
      readClipboardText: async () =>
        (await call('native.clipboard.read', { mime }, clipboardReadResultSchema)).value,
      pickMedia: async (source, multiple) =>
        (await call('native.media.pick', { source, multiple }, mediaPickResultSchema)).items,
      readMedia: (handle, offset, length) =>
        call('native.media.read', { handle, offset, length }, mediaReadResultSchema),
      releaseMedia: async (handle) =>
        (await call('native.media.release', { handle }, mediaReleaseResultSchema)).released,
      nameMedia: async (handle) =>
        (await call('native.media.name', { handle }, mediaNameResultSchema)).name,
      startAudio: (sampleRate) =>
        call('native.audio.start', { sampleRate }, audioStartResultSchema),
      readAudio: (maxBytes) => call('native.audio.read', { maxBytes }, audioReadResultSchema),
      stopAudio: () => call('native.audio.stop', {}, audioStopResultSchema)
    }
  }, [client])
}
