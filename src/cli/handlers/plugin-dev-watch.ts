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
import { CLI_BOOLEAN_FLAGS } from '../../shared/cli-argument-boundary'
import { checkPluginDevFolder } from '../plugin-dev-watch/plugin-dev-watch-check'
import { pluginDevWatchConfirmFor } from '../plugin-dev-watch/plugin-dev-watch-approval'
import {
  pluginDevWatchShotPanel,
  type PluginDevWatchShotHost
} from '../plugin-dev-watch/plugin-dev-watch-shot'
import { defaultPluginShotPath, resolveLocalShotPath, takePluginShotIfShown } from './plugin-view'
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

// Why: `dev reload` rejects watch-only flags; the old `--approve` is replaced by the new one.
const WATCH_ONLY_FLAGS = new Set(['check', 'shot', 'shot-panel', 'approve'])

/** `orca … plugin dev watch <dir>` → `… plugin dev reload <dir>`, so approving keeps this session. */
export function devReloadArgs(rawArgs: readonly string[]): string[] {
  const watch = rawArgs.findIndex((arg, index) => arg === 'watch' && rawArgs[index - 1] === 'dev')
  const kept: string[] = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const name = arg.startsWith('--') ? arg.slice(2).split('=')[0] : null
    if (name === null || !WATCH_ONLY_FLAGS.has(name)) {
      kept.push(index === watch ? 'reload' : arg)
      continue
    }
    // Same value rule as parseArgs: a non-boolean flag takes the next token unless it is a flag.
    const next = rawArgs[index + 1]
    if (
      !arg.includes('=') &&
      !CLI_BOOLEAN_FLAGS.has(name) &&
      next !== undefined &&
      !next.startsWith('--')
    ) {
      index += 1
    }
  }
  return kept
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

function bindShotHost(
  ctx: HandlerContext,
  shotDir: string,
  shotPanel: string | boolean | undefined
): PluginDevWatchShotHost {
  return {
    panelOf: (entry) =>
      pluginDevWatchShotPanel(entry, typeof shotPanel === 'string' ? shotPanel : undefined),
    open: async (pluginKey, panelId) => {
      await callPlugins(ctx, 'plugins.open', { pluginKey, panelId })
    },
    take: async (pluginKey, panelId) => {
      const shot = await takePluginShotIfShown(ctx, {
        pluginKey,
        panelId,
        outFor: (id) => defaultPluginShotPath(shotDir, pluginKey, id)
      })
      if ('notShown' in shot) {
        return { notShown: shot.notShown }
      }
      const { path: file, width, height, settled, errors, pendingRequests } = shot
      return {
        panelId,
        path: file,
        width,
        height,
        settled,
        errors,
        ...(pendingRequests === undefined ? {} : { pendingRequests })
      }
    }
  }
}

export function bindPluginDevWatchHost(ctx: HandlerContext, path: string): PluginDevWatchHost {
  const approve = ctx.flags.get('approve')
  const check = ctx.flags.get('check') === true
  // Why local only: the check renders the folder's code on this machine, not on the Orca host.
  if (check && ctx.client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--check renders the plugin on this machine, so it needs a local folder; drop --environment or --check.'
    )
  }
  const shotFlag = ctx.flags.get('shot')
  const shotDir = typeof shotFlag === 'string' ? resolveLocalShotPath(ctx, shotFlag) : null
  const shotPanel = ctx.flags.get('shot-panel')
  if (shotPanel !== undefined && shotDir === null) {
    throw new RuntimeClientError('invalid_argument', '--shot-panel needs --shot <out-dir>.')
  }
  return {
    ...(check ? { check: () => checkPluginDevFolder(path) } : {}),
    ...(shotDir ? { shot: bindShotHost(ctx, shotDir, shotPanel) } : {}),
    refreshTypes: () => refreshDevTypes(ctx, path),
    devLoad: (approvalFingerprint) =>
      callPlugins<DevLoadResult>(ctx, 'plugins.devLoad', {
        path,
        approvalFingerprint:
          approvalFingerprint ?? (typeof approve === 'string' ? approve : undefined)
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
      isConnectionLost: (error) => error instanceof PluginHostUnreachableError,
      confirm: pluginDevWatchConfirmFor(ctx.json)
    })
  }
}
