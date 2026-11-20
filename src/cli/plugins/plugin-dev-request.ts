import { PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS } from '../../shared/plugins/workers/plugin-panel-bridge-protocol'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalPositiveIntegerFlag } from '../arguments/flags'
import { printPluginResult, requirePluginPathArg } from './plugin-cli-output'
import { parseDataFlag } from './plugin-dev-emit'
import { callPlugins, devTargetParams, requirePluginKey, stringFlag } from './plugin-runtime'

type PluginRequestReply = { pluginKey: string; name: string; result: unknown }

// Why: the host may start the worker first, so the CLI waits past the handler's own deadline.
const WORKER_START_GRACE_MS = 30_000

async function requestHandler(
  ctx: HandlerContext,
  method: 'plugins.request' | 'plugins.devRequest',
  target: { pluginKey: string } | { path: string }
): Promise<void> {
  const name = requirePluginPathArg(ctx, 'name')
  const timeoutMs = getOptionalPositiveIntegerFlag(ctx.flags, 'timeout-ms')
  const result = await callPlugins<PluginRequestReply>(
    ctx,
    method,
    {
      ...target,
      name,
      input: parseDataFlag(ctx),
      timeoutMs,
      ...(method === 'plugins.devRequest' ? { panel: stringFlag(ctx, 'panel') } : {})
    },
    { timeoutMs: (timeoutMs ?? PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS) + WORKER_START_GRACE_MS }
  )
  printPluginResult(ctx, result, JSON.stringify(result.result ?? null, null, 2))
}

export const PLUGIN_DEV_REQUEST_HANDLERS: Record<string, CommandHandler> = {
  'plugin request': (ctx) =>
    requestHandler(ctx, 'plugins.request', { pluginKey: requirePluginKey(ctx) }),
  'plugin dev request': (ctx) =>
    requestHandler(
      ctx,
      'plugins.devRequest',
      devTargetParams(ctx, requirePluginPathArg(ctx, 'target'))
    )
}
