import { useMemo } from 'react'
import { z } from 'zod'
import { usePageBridgeClient } from '../../transport/client-context.web'
import {
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

/**
 * The page's side of the shell-answered verbs, typed from the same table the host serves.
 *
 * Every member goes out as an ordinary `request`, so it settles on the same frames and counts
 * against the same in-flight cap as any other. What makes it a native verb is the method name: the
 * host answers anything under the `native.` prefix itself and never forwards it.
 *
 * A verb the shell did not grant is refused before a frame is sent, because the answer is what the
 * caller acts on: a promise that rejected after a round trip and one that never left look the same
 * to an `await`, but only the first costs a slot.
 *
 * Results are parsed rather than trusted. The shell is not hostile, but it is a different build
 * than the page, and a verb whose result shape moved should fail here rather than halfway through
 * a screen that read a field which is not there.
 */
export type NativeVerbs = {
  /** Whether this shell serves the clipboard verbs at all; false leaves a caller its own fallback. */
  granted: boolean
  /**
   * Per verb, because the grants are per verb and a caller usually wants one of them.
   *
   * `granted` is both, which is the right question for a screen that copies and pastes and the
   * wrong one for anything else: a route granted only `native.clipboard.read` reads `granted`
   * false and would report an empty clipboard rather than one it is allowed to read.
   */
  canWriteClipboardText: boolean
  canReadClipboardText: boolean
  /**
   * Whether the shell serves all three media verbs, which is the page's only route to an image.
   *
   * All three, not the two a read needs. Every caller releases what it picked, and a shell that
   * granted `pick` and `read` but not `release` would take the handles and never give them back:
   * the release rejects, the cleanup swallows it by design, and the staged files stay live to the
   * five-minute TTL — eight pastes and the next pick is refused at the cap. A route missing one
   * verb has no working image path, so this says so up front rather than after four of them.
   *
   * Read by `contents()` on the clipboard seam, which answers without probing: a route granted all
   * three may have an image on the pasteboard, and one that is not never can.
   */
  canPickMedia: boolean
  writeClipboardText: (value: string) => Promise<boolean>
  readClipboardText: () => Promise<string>
  /** Opens the shell's picker and answers a handle per item; an empty list is a cancelled picker,
   *  which is not a fault and never a rejection. */
  pickMedia: (source: BridgeMediaSource, multiple: boolean) => Promise<readonly BridgeMediaItem[]>
  /** One byte range of a staged item. `length` above the cap is refused by the shell's schema, so
   *  a caller bounds its own ask rather than discovering the bound as a rejection. */
  readMedia: (handle: string, offset: number, length: number) => Promise<BridgeMediaChunk>
  /** False for a handle this session no longer holds, which is not a fault. */
  releaseMedia: (handle: string) => Promise<boolean>
  /** Opens the microphone, running the OS prompt if there is one. A denied microphone and an
   *  engine that would not open are both answers here rather than rejections. */
  startAudio: (sampleRate: number) => Promise<z.infer<typeof audioStartResultSchema>>
  /** One drain of the shell's ring. `maxBytes` above the ring is refused by the shell's schema, so
   *  a caller bounds its own ask rather than discovering the bound as a rejection. */
  readAudio: (maxBytes: number) => Promise<BridgeAudioChunk>
  /** Ends the capture and brings back what the shell's ring still held, which is the tail of the
   *  utterance no drain came back for. `stopped` is false for a session that was not capturing,
   *  which is not a fault. */
  stopAudio: () => Promise<z.infer<typeof audioStopResultSchema>>
}

/**
 * Every way a verb can fail, in one shape a caller can switch on.
 *
 * `reason` is always a member of `NATIVE_VERB_REASONS`: one per fault the seam names, plus
 * `ungranted` which this side decides before a frame is sent, plus the frame refusals such as
 * `reply-too-large`. A code from a shell newer than this page floors to `unreported` rather than
 * crossing verbatim, so a `switch` over the list stays exhaustive.
 *
 * The message is not a contract. It is the shell's words where it had any, which say which verb
 * and roughly why; a handler's own words never cross, so nothing may be read out of it.
 */
export class NativeVerbError extends Error {
  readonly reason: NativeVerbReason

  constructor(reason: NativeVerbReason, message: string) {
    super(message)
    this.name = 'NativeVerbError'
    this.reason = reason
  }
}

/**
 * The shell's own code, which `reconstructBridgeError` copies onto the rejection it builds.
 *
 * `code` is not a property of `Error`, so it is parsed into a named shape rather than reached for:
 * the rejection is whatever crossed the bridge, and a schema says what this reads without
 * asserting the rest of it away.
 */
const shellCodedErrorSchema = z.object({ code: z.string() })

/**
 * Every reason a caller can be handed, so a `switch` over them is exhaustive.
 *
 * `ungranted` is this side's, decided before a frame is sent. The rest are the shell's, carried on
 * the rejection by `reconstructBridgeError`. `unreported` is the floor: nothing in this build
 * reaches it, and it exists so a shell newer than the page still produces a reason rather than a
 * blank one.
 */
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

/**
 * Floored, not passed through: a shell newer than this page can name a code this build has never
 * heard of, and handing it to a caller switching over the list would fall off the end silently.
 */
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

    /**
     * One parse of the result, with the verb's own schema, inside the catch.
     *
     * The host validated the same shape before it answered; this is the page's own check that the
     * shell it is talking to is the build it expects. Parsing again at a caller would sit outside
     * this catch and escape as a bare `ZodError`, which is the one shape this surface promises not
     * to throw.
     */
    async function call<Value>(
      verb: BridgeNativeVerb,
      params: unknown,
      result: z.ZodType<Value>
    ): Promise<Value> {
      if (!has(verb)) {
        throw new NativeVerbError('ungranted', `this shell did not grant ${verb}`)
      }
      try {
        // No `ok: false` arm: a refusal crosses as an `error` frame and rejects this await, and a
        // `native.` method is never forwarded, so there is no host `RpcFailure` to carry back.
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
      startAudio: (sampleRate) =>
        call('native.audio.start', { sampleRate }, audioStartResultSchema),
      readAudio: (maxBytes) => call('native.audio.read', { maxBytes }, audioReadResultSchema),
      stopAudio: () => call('native.audio.stop', {}, audioStopResultSchema)
    }
  }, [client])
}
