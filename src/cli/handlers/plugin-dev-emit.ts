import type { CommandHandler, HandlerContext } from '../dispatch'
import { printPluginResult, requirePluginPathArg } from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError } from '../runtime/types'
import { callPlugins, devTargetParams, stringFlag } from './plugin-runtime'

export type PluginDevEmitReply = {
  pluginKey: string
  event: string
  delivered: { worker: boolean; panels: number }
}

/** `--data` as JSON; shared by `dev emit` and `dev request`. */
export function parseDataFlag(ctx: HandlerContext): unknown {
  const raw = stringFlag(ctx, 'data')
  if (raw === undefined) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--data is not JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export const PLUGIN_DEV_EMIT_HANDLERS: Record<string, CommandHandler> = {
  'plugin dev emit': async (ctx) => {
    const target = devTargetParams(ctx, requirePluginPathArg(ctx, 'target'))
    const event = requirePluginPathArg(ctx, 'event')
    const result = await callPlugins<PluginDevEmitReply>(ctx, 'plugins.devEmit', {
      ...target,
      event,
      payload: parseDataFlag(ctx)
    })
    printPluginResult(
      ctx,
      result,
      `Sent ${result.event} to ${result.pluginKey}'s worker; handler errors show in \`orca plugin logs ${result.pluginKey}\`.`
    )
  }
}
