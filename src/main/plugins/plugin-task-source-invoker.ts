/**
 * The only ways a task source call reaches a consumer: `invokePluginTaskSourceMethod`
 * builds the extension-point proxy (validates the worker's reply against the
 * method's schema, scrubs a rejection), and `invokeContributedTaskSource`
 * is the client-facing (RPC/IPC) entry that resolves and calls that proxy.
 * Together they mean a third-party plugin can neither hand core an
 * unchecked shape nor leak a stack trace into the UI.
 */

import type { z } from 'zod'
import {
  isPluginTaskSourceMethod,
  pluginTaskSourceResultSchema,
  type PluginTaskSourceMethod,
  type PluginTaskSourceResult
} from '../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceProxy } from '../../shared/plugins/plugin-extension-registry'

export type InvokePluginTaskSourceInput<T extends z.ZodTypeAny> = {
  callWorker: (request: {
    pluginKey: string
    sourceId: string
    method: PluginTaskSourceMethod
    params: unknown
  }) => Promise<unknown>
  pluginKey: string
  sourceId: string
  method: PluginTaskSourceMethod
  params: unknown
  resultSchema: T
}

function unavailable(
  sourceId: string,
  reason: string
): { ok: false; code: 'unavailable'; message: string } {
  return { ok: false, code: 'unavailable', message: `task source ${sourceId} ${reason}` }
}

export async function invokePluginTaskSourceMethod<T extends z.ZodTypeAny>(
  input: InvokePluginTaskSourceInput<T>
): Promise<PluginTaskSourceResult<z.infer<T>>> {
  let raw: unknown
  try {
    raw = await input.callWorker({
      pluginKey: input.pluginKey,
      sourceId: input.sourceId,
      method: input.method,
      params: input.params
    })
  } catch {
    // Loss of contact with a worker is never evidence of an empty result.
    // The worker's raw error string (built from error.stack ?? error.message)
    // is not user-facing: it can carry a third-party plugin's stack trace.
    return unavailable(input.sourceId, 'is unavailable')
  }

  const parsed = pluginTaskSourceResultSchema(input.resultSchema).safeParse(raw)
  if (!parsed.success) {
    return unavailable(input.sourceId, 'returned a malformed result')
  }
  return parsed.data
}

export type InvokeContributedTaskSourceInput = {
  resolveProxy: (pluginKey: string, sourceId: string) => PluginTaskSourceProxy | null
  pluginKey: string
  sourceId: string
  method: string
  params?: unknown
}

/**
 * Client-facing entry from RPC/IPC into a contributed task source. `method`
 * arrives off the wire as an untyped string: an unknown value must never
 * reach `PluginTaskSourceProxy.call`, whose result-schema lookup is
 * `undefined` for it and throws. Resolves through the extension-point
 * registry only — never `PluginService.invokeTaskSource`, which skips the
 * proxy's validation and error scrubbing.
 */
export async function invokeContributedTaskSource(
  input: InvokeContributedTaskSourceInput
): Promise<PluginTaskSourceResult<unknown>> {
  if (!isPluginTaskSourceMethod(input.method)) {
    return { ok: false, code: 'validation', message: `unknown task source method ${input.method}` }
  }
  const proxy = input.resolveProxy(input.pluginKey, input.sourceId)
  if (!proxy) {
    return unavailable(input.sourceId, 'is not registered')
  }
  return proxy.call(input.method, input.params)
}
