import { useMemo } from 'react'
import { z } from 'zod'
import { usePageBridgeClient } from '../../transport/client-context.web'
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
  /** Whether this shell serves the verbs at all; false leaves a caller its own fallback. */
  granted: boolean
  writeClipboardText: (value: string) => Promise<boolean>
  readClipboardText: () => Promise<string>
}

/**
 * Every way a verb can fail, in one shape a caller can switch on.
 *
 * `reason` is the shell's own code where there is one — `native_verb_refused` for anything the seam
 * declined, or the frame refusal such as `reply-too-large` for a reply the page could never have
 * received. `ungranted` is this side's, decided before a frame is sent. The message stays the
 * shell's words, because that is what says which verb and why, but nothing should switch on it.
 */
export class NativeVerbError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
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

function nativeVerbReason(error: unknown): string {
  const coded = shellCodedErrorSchema.safeParse(error)
  return coded.success ? coded.data.code : 'unknown'
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
    return {
      granted: has('native.clipboard.write') && has('native.clipboard.read'),
      writeClipboardText: async (value) =>
        (await call('native.clipboard.write', { mime, value }, clipboardWriteResultSchema)).written,
      readClipboardText: async () =>
        (await call('native.clipboard.read', { mime }, clipboardReadResultSchema)).value
    }
  }, [client])
}
