import { useMemo } from 'react'
import { usePageBridgeClient } from '../../transport/client-context.web'
import {
  BRIDGE_NATIVE_VERBS,
  clipboardReadParamsSchema,
  clipboardReadResultSchema,
  clipboardWriteParamsSchema,
  clipboardWriteResultSchema,
  type BridgeClipboardMime
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

class NativeVerbUngrantedError extends Error {
  constructor(verb: string) {
    super(`this shell did not grant ${verb}`)
    this.name = 'NativeVerbUngrantedError'
  }
}

export function useNativeVerbs(): NativeVerbs {
  const client = usePageBridgeClient()

  return useMemo<NativeVerbs>(() => {
    const has = (verb: string): boolean =>
      client.getShellSession()?.grants.native.includes(verb) === true

    async function call(verb: keyof typeof BRIDGE_NATIVE_VERBS, params: unknown): Promise<unknown> {
      if (!has(verb)) {
        throw new NativeVerbUngrantedError(verb)
      }
      const reply = await client.sendRequest(verb, params)
      if (!reply.ok) {
        throw new Error(reply.error.message)
      }
      return BRIDGE_NATIVE_VERBS[verb].result.parse(reply.result)
    }

    const mime: BridgeClipboardMime = 'text'
    return {
      granted: has('native.clipboard.write') && has('native.clipboard.read'),
      writeClipboardText: async (value) => {
        const params = clipboardWriteParamsSchema.parse({ mime, value })
        const result = await call('native.clipboard.write', params)
        return clipboardWriteResultSchema.parse(result).written
      },
      readClipboardText: async () => {
        const params = clipboardReadParamsSchema.parse({ mime })
        const result = await call('native.clipboard.read', params)
        return clipboardReadResultSchema.parse(result).value
      }
    }
  }, [client])
}
