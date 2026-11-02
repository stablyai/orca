import type { CommandHandler, HandlerContext } from '../dispatch'
import { printPluginResult, requirePluginPathArg } from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError } from '../runtime/types'
import { callPlugins, devTargetParams, stringFlag } from './plugin-runtime'

export type PluginDevEmitReply = {
  pluginKey: string
  event: string
  delivered: { worker: boolean; panels: number }
}

export type PluginDevHookReply = {
  pluginKey: string
  event: string
  decision: { kind: 'continue'; event: unknown } | { kind: 'deny'; reason: string }
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
  'plugin dev hook': async (ctx) => {
    const target = devTargetParams(ctx, requirePluginPathArg(ctx, 'target'))
    const event = requirePluginPathArg(ctx, 'event')
    const result = await callPlugins<PluginDevHookReply>(ctx, 'plugins.devHook', {
      ...target,
      event,
      payload: parseDataFlag(ctx)
    })
    const decision = result.decision
    printPluginResult(
      ctx,
      result,
      decision.kind === 'deny'
        ? `${result.event}: denied by ${result.pluginKey}: ${decision.reason}`
        : `${result.event}: continue with ${JSON.stringify(decision.event)}`
    )
  },
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
