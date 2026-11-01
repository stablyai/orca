import { useMemo } from 'react'
import { NativeVerbError, NATIVE_VERB_REASONS, type NativeVerbReason } from './native-verb-error'
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
  pdfViewResultSchema,
  type BridgeClipboardMime,
  type BridgeNativeVerb,
  type BridgePdfOpenParams
} from './bridge-native-verbs'

export { NativeVerbError, NATIVE_VERB_REASONS } from './native-verb-error'
export type { NativeVerbReason } from './native-verb-error'

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
  canOpenPdf: boolean
  openPdf: (params: BridgePdfOpenParams) => Promise<void>
  cancelPdf: () => Promise<void>
}

// Parse arbitrary rejection code into its checked shape; Error itself declares no code property.
const shellCodedErrorSchema = z.object({ code: z.string() })

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
      stopAudio: () => call('native.audio.stop', {}, audioStopResultSchema),
      canOpenPdf: has('native.pdf.view'),
      openPdf: async (params) => {
        await call('native.pdf.view', { action: 'open', ...params }, pdfViewResultSchema)
      },
      cancelPdf: async () => {
        await call('native.pdf.view', { action: 'cancel' }, pdfViewResultSchema)
      }
    }
  }, [client])
}
