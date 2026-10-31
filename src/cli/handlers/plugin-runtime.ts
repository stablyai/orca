import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printPluginResult, requirePluginPathArg } from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'

type DevLoadResult = {
  path: string
  pluginKey: string
  added: boolean
  approval: 'content-only' | 'approve-flag' | 'already-approved'
  plugin: PluginHostListEntry | null
}
type LogsResult = { pluginKey: string; lines: { ts: number; level: string; line: string }[] }

const APPROVAL_CODES = new Set(['approval_required', 'approval_stale'])

function stringFlag(ctx: HandlerContext, name: string): string | undefined {
  const value = ctx.flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The caller's exact command with `--approve <fingerprint>`, so nothing else changes on re-run. */
export function approvalRerunCommand(rawArgs: readonly string[], fingerprint: string): string {
  const kept: string[] = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (arg === '--approve') {
      index += 1
      continue
    }
    if (arg.startsWith('--approve=')) {
      continue
    }
    kept.push(arg)
  }
  return ['orca', ...kept, '--approve', fingerprint].map(quoteCliCommandArgument).join(' ')
}

function approvalFingerprintOf(data: unknown): string | null {
  return typeof data === 'object' &&
    data !== null &&
    'approvalFingerprint' in data &&
    typeof data.approvalFingerprint === 'string'
    ? data.approvalFingerprint
    : null
}

function nextStepsOf(data: unknown): string[] {
  return typeof data === 'object' &&
    data !== null &&
    'nextSteps' in data &&
    Array.isArray(data.nextSteps)
    ? data.nextSteps.filter((step): step is string => typeof step === 'string')
    : []
}

function translatePluginRpcError(ctx: HandlerContext, method: string, error: unknown): unknown {
  if (!(error instanceof RuntimeRpcFailureError)) {
    return error
  }
  const { code, message, data } = error.response.error
  if (code === 'method_not_found') {
    return new RuntimeClientError(
      'runtime_unsupported',
      `The Orca host this command reached is too old for \`${method}\`.`,
      { nextSteps: ['Update Orca on that host, then run the command again.'] }
    )
  }
  const fingerprint = approvalFingerprintOf(data)
  if (!APPROVAL_CODES.has(code) || fingerprint === null || typeof data !== 'object') {
    return error
  }
  const command = approvalRerunCommand(ctx.rawArgs ?? [], fingerprint)
  const nextSteps = nextStepsOf(data).map((step) =>
    step.startsWith('To approve, run the same command again') ? `To approve, run: ${command}` : step
  )
  return new RuntimeClientError(code, message, { ...data, command, nextSteps })
}

async function callPlugins<T>(ctx: HandlerContext, method: string, params?: unknown): Promise<T> {
  try {
    return (await ctx.client.call<T>(method, params)).result
  } catch (error) {
    throw translatePluginRpcError(ctx, method, error)
  }
}

/** Development folders are paths on the Orca host, which may not be this machine. */
function resolveHostPluginPath(ctx: HandlerContext, value: string): string {
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_environment',
      'This shell forwards orca to an Orca host on another machine, which cannot read this folder. Run the command on the machine that runs Orca, or pass --environment for an Orca server that has the folder.'
    )
  }
  if (isAbsolute(value)) {
    return value
  }
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass an absolute path on the Orca server; a relative path names a folder on this machine.'
    )
  }
  return resolve(ctx.cwd, value)
}

function formatPluginRow(plugin: PluginHostListEntry): string {
  const tags = [plugin.execution, plugin.isDev ? 'dev' : null, plugin.official ? 'official' : null]
  return `${plugin.pluginKey} ${plugin.version}  ${plugin.status}  ${tags.filter(Boolean).join(', ')}${plugin.error ? `\n  ${plugin.error}` : ''}`
}

function formatDevLoad(result: DevLoadResult): string {
  const how =
    result.approval === 'approve-flag'
      ? 'approved with --approve'
      : result.approval === 'content-only'
        ? 'content only, no approval needed'
        : 'already approved'
  return [
    `${result.added ? 'Loaded' : 'Reloaded'} ${result.pluginKey} from ${result.path} (${how}).`,
    result.plugin ? formatPluginRow(result.plugin) : '',
    'Orca reloads it when its files change; `orca plugin logs` shows what it printed.'
  ]
    .filter(Boolean)
    .join('\n')
}

async function devLoad(ctx: HandlerContext, path: string): Promise<void> {
  const result = await callPlugins<DevLoadResult>(ctx, 'plugins.devLoad', {
    path,
    approvalFingerprint: stringFlag(ctx, 'approve')
  })
  printPluginResult(ctx, result, formatDevLoad(result))
}

function requirePluginKey(ctx: HandlerContext): string {
  const key = stringFlag(ctx, 'plugin')
  if (!key || !isQualifiedPluginKey(key)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a plugin key such as acme.dusk; `orca plugin list` shows them.'
    )
  }
  return key
}

async function setEnabled(ctx: HandlerContext, enabled: boolean): Promise<void> {
  const pluginKey = requirePluginKey(ctx)
  const list = await callPlugins<PluginHostListEntry[]>(ctx, 'plugins.setEnabled', {
    pluginKey,
    enabled,
    ...(enabled ? { approvalFingerprint: stringFlag(ctx, 'approve') } : {})
  })
  const plugin = list.find((entry) => entry.pluginKey === pluginKey) ?? null
  printPluginResult(
    ctx,
    { pluginKey, enabled, plugin },
    plugin ? formatPluginRow(plugin) : `${pluginKey} ${enabled ? 'enabled' : 'disabled'}`
  )
}

export const PLUGIN_RUNTIME_HANDLERS: Record<string, CommandHandler> = {
  'plugin list': async (ctx) => {
    const plugins = await callPlugins<PluginHostListEntry[]>(ctx, 'plugins.list')
    printPluginResult(
      ctx,
      { plugins },
      plugins.length === 0 ? 'No plugins.' : plugins.map(formatPluginRow).join('\n')
    )
  },
  'plugin logs': async (ctx) => {
    const result = await callPlugins<LogsResult>(ctx, 'plugins.getLogs', {
      pluginKey: requirePluginKey(ctx)
    })
    printPluginResult(
      ctx,
      result,
      result.lines.length === 0
        ? `No log lines from ${result.pluginKey}.`
        : result.lines
            .map((line) => `${new Date(line.ts).toISOString()} ${line.level} ${line.line}`)
            .join('\n')
    )
  },
  'plugin enable': (ctx) => setEnabled(ctx, true),
  'plugin disable': (ctx) => setEnabled(ctx, false),
  'plugin dev load': (ctx) =>
    devLoad(ctx, resolveHostPluginPath(ctx, requirePluginPathArg(ctx, 'dir'))),
  'plugin dev reload': async (ctx) => {
    const dir = stringFlag(ctx, 'dir')
    if (dir) {
      await devLoad(ctx, resolveHostPluginPath(ctx, dir))
      return
    }
    const plugins = await callPlugins<PluginHostListEntry[]>(ctx, 'plugins.refresh')
    printPluginResult(ctx, { plugins }, `Reloaded ${plugins.length} plugin(s).`)
  },
  'plugin dev unload': async (ctx) => {
    const target = requirePluginPathArg(ctx, 'target')
    // Why the folder check first: a folder may be named like a plugin key.
    const localFolder = !ctx.client.isRemote && existsSync(resolve(ctx.cwd, target))
    const params =
      !localFolder && !isAbsolute(target) && isQualifiedPluginKey(target)
        ? { pluginKey: target }
        : { path: resolveHostPluginPath(ctx, target) }
    const result = await callPlugins<{ path: string; pluginKey: string | null }>(
      ctx,
      'plugins.devUnload',
      params
    )
    printPluginResult(ctx, result, `Unloaded ${result.pluginKey ?? 'the folder'} (${result.path}).`)
  }
}
