import type { CommandHandler, HandlerContext } from '../dispatch'
import { requirePluginPathArg } from '../plugin-authoring/plugin-cli-output'
import {
  formatPluginDevWatchEvent,
  type PluginDevWatchApproval
} from '../plugin-dev-watch/plugin-dev-watch-events'
import {
  runPluginDevWatch,
  type PluginDevWatchHost
} from '../plugin-dev-watch/plugin-dev-watch-loop'
import {
  onPluginDevWatchInterrupt,
  waitUnlessAborted
} from '../plugin-dev-watch/plugin-dev-watch-process'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import { writeStdoutLine } from '../stdout-line'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import {
  callPlugins,
  refreshDevTypes,
  resolveHostPluginPath,
  translatePluginRpcError,
  type DevLoadResult,
  type LogsResult
} from './plugin-runtime'

/** The host did not answer: Orca quit, or the network to a remote server dropped. */
export class PluginHostUnreachableError extends Error {}

/** `orca … plugin dev watch <dir>` → `… plugin dev reload <dir>`, so approving keeps this session. */
export function devReloadArgs(rawArgs: readonly string[]): string[] {
  const watch = rawArgs.findIndex((arg, index) => arg === 'watch' && rawArgs[index - 1] === 'dev')
  return rawArgs.map((arg, index) => (index === watch ? 'reload' : arg))
}

function approvalOf(error: unknown): PluginDevWatchApproval | null {
  if (!(error instanceof RuntimeClientError) || typeof error.data !== 'object' || !error.data) {
    return null
  }
  const data = error.data
  const fingerprint =
    'approvalFingerprint' in data && typeof data.approvalFingerprint === 'string'
      ? data.approvalFingerprint
      : null
  const command = 'command' in data && typeof data.command === 'string' ? data.command : null
  return fingerprint && command ? { message: error.message, fingerprint, command } : null
}

/** Why classify before translating: any reply, even an error, proves the host is still there. */
async function pollHost<T>(ctx: HandlerContext, method: string, params?: unknown): Promise<T> {
  try {
    return (await ctx.client.call<T>(method, params)).result
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError) {
      throw translatePluginRpcError(ctx, method, error)
    }
    throw new PluginHostUnreachableError(error instanceof Error ? error.message : String(error))
  }
}

export function bindPluginDevWatchHost(ctx: HandlerContext, path: string): PluginDevWatchHost {
  const approve = ctx.flags.get('approve')
  return {
    refreshTypes: () => refreshDevTypes(ctx, path),
    devLoad: () =>
      callPlugins<DevLoadResult>(ctx, 'plugins.devLoad', {
        path,
        approvalFingerprint: typeof approve === 'string' ? approve : undefined
      }),
    list: () => pollHost<PluginHostListEntry[]>(ctx, 'plugins.list'),
    logs: (pluginKey, after) =>
      pollHost<LogsResult>(ctx, 'plugins.getLogs', { pluginKey, ...(after ? { after } : {}) }),
    approvalNeeded: async () => {
      const reloadCtx = { ...ctx, rawArgs: devReloadArgs(ctx.rawArgs ?? []) }
      try {
        await pollHost(reloadCtx, 'plugins.devLoad', { path })
        return null
      } catch (error) {
        const approval = approvalOf(error)
        if (approval) {
          return approval
        }
        throw error
      }
    },
    devUnload: async () => {
      await pollHost(ctx, 'plugins.devUnload', { path })
    }
  }
}

export const PLUGIN_DEV_WATCH_HANDLERS: Record<string, CommandHandler> = {
  'plugin dev watch': async (ctx) => {
    const path = resolveHostPluginPath(ctx, requirePluginPathArg(ctx, 'dir'))
    process.exitCode = await runPluginDevWatch({
      host: bindPluginDevWatchHost(ctx, path),
      emit: (event) =>
        writeStdoutLine(ctx.json ? JSON.stringify(event) : formatPluginDevWatchEvent(event)),
      wait: waitUnlessAborted,
      onInterrupt: onPluginDevWatchInterrupt,
      exitNow: (code) => process.exit(code),
      isConnectionLost: (error) => error instanceof PluginHostUnreachableError
    })
  }
}
