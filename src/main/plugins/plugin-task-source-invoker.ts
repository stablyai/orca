import type { z } from 'zod'
import {
  pluginTaskSourceResultSchema,
  type PluginTaskSourceErrorCode,
  type PluginTaskSourceMethod,
  type PluginTaskSourceResult
} from '../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceRegistry } from './plugin-task-source-registry'

export type InvokePluginTaskSourceInput<T extends z.ZodTypeAny> = {
  registry: PluginTaskSourceRegistry
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

function failure(
  code: PluginTaskSourceErrorCode,
  message: string
): { ok: false; code: PluginTaskSourceErrorCode; message: string } {
  return { ok: false, code, message }
}

export async function invokePluginTaskSourceMethod<T extends z.ZodTypeAny>(
  input: InvokePluginTaskSourceInput<T>
): Promise<PluginTaskSourceResult<z.infer<T>>> {
  const registration = input.registry.find(input.pluginKey, input.sourceId)
  if (!registration) {
    return failure('not_found', `no task source ${input.sourceId} for plugin ${input.pluginKey}`)
  }

  let raw: unknown
  try {
    raw = await input.callWorker({
      pluginKey: input.pluginKey,
      sourceId: input.sourceId,
      method: input.method,
      params: input.params
    })
  } catch (error) {
    // Loss of contact with a worker is never evidence of an empty result.
    return failure('unavailable', error instanceof Error ? error.message : String(error))
  }

  const parsed = pluginTaskSourceResultSchema(input.resultSchema).safeParse(raw)
  if (!parsed.success) {
    return failure('unavailable', `task source ${input.sourceId} returned a malformed result`)
  }
  return parsed.data
}
