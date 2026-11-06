import type { CommandHandler } from '../dispatch'
import { getOptionalPositiveIntegerFlag } from '../flags'
import { printPluginResult, requirePluginPathArg } from '../plugin-authoring/plugin-cli-output'
import { parseDataFlag } from './plugin-dev-emit'
import { callPlugins, devTargetParams, stringFlag } from './plugin-runtime'

export type PluginDevRequestReply = { pluginKey: string; name: string; result: unknown }

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000
// Why: the host may start the worker first, so the CLI waits past the handler's own deadline.
const WORKER_START_GRACE_MS = 30_000

export const PLUGIN_DEV_REQUEST_HANDLERS: Record<string, CommandHandler> = {
  'plugin dev request': async (ctx) => {
    const target = devTargetParams(ctx, requirePluginPathArg(ctx, 'target'))
    const name = requirePluginPathArg(ctx, 'name')
    const input = parseDataFlag(ctx)
    const timeoutMs = getOptionalPositiveIntegerFlag(ctx.flags, 'timeout-ms')
    const result = await callPlugins<PluginDevRequestReply>(
      ctx,
      'plugins.devRequest',
      { ...target, name, input, panel: stringFlag(ctx, 'panel'), timeoutMs },
      { timeoutMs: (timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS) + WORKER_START_GRACE_MS }
    )
    printPluginResult(ctx, result, JSON.stringify(result.result ?? null, null, 2))
  }
}
