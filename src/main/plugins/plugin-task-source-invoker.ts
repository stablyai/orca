/**
 * The only way a task source call reaches a consumer. It validates the
 * worker's reply against the method's schema and scrubs a rejection, so a
 * third-party plugin can neither hand core an unchecked shape nor leak a
 * stack trace into the UI.
 */

import type { z } from 'zod'
import {
  pluginTaskSourceResultSchema,
  type PluginTaskSourceMethod,
  type PluginTaskSourceResult
} from '../../shared/plugins/plugin-task-source-contract'

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
