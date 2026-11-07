import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printPluginResult, requirePluginPathArg } from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError } from '../runtime/types'
import {
  isQualifiedPluginKey,
  PLUGIN_MANIFEST_FILENAME
} from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import {
  pluginInstallSourceLines,
  type PluginInstallSourceInfo
} from '../../shared/plugins/installation/plugin-install-source-info'
import {
  callPlugins,
  formatPluginRow,
  requirePluginKey,
  resolveHostPluginPath,
  stringFlag
} from './plugin-runtime'

// Why long: a first install may resolve, download and verify a repository twice over a slow link.
const INSTALL_TIMEOUT = { timeoutMs: 10 * 60_000 }

type InstallSpec =
  | { kind: 'catalog'; pluginKey: string; catalog?: string }
  | { kind: 'git'; input: string }
  | { kind: 'local-path'; path: string }

type InstallResult = {
  pluginKey: string
  version: string
  previousVersion: string | null
  approval: string
  source: PluginInstallSourceInfo
  plugin?: PluginHostListEntry | null
}

type UpdateResult =
  | ({ status: 'updated' } & InstallResult)
  | { status: 'up-to-date' | 'pinned'; pluginKey: string; version: string; reason: string }

type CatalogEntry = {
  id: string
  url: string
  ref: string
  name: string | null
  official: boolean
  stale: boolean
  error: string | null
}

const SHORTHAND_WITH_REF = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)@([^@\s]+)$/

function looksLikePath(value: string): boolean {
  return (
    value.startsWith('.') ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  )
}

/** Sorts what the caller typed into a catalog id, a Git source or a folder on the Orca host. */
export function classifyPluginInstallSource(ctx: HandlerContext, value: string): InstallSpec {
  const ref = stringFlag(ctx, 'ref')
  const catalog = stringFlag(ctx, 'catalog')
  const localFolder =
    !ctx.client.isRemote && existsSync(join(resolve(ctx.cwd, value), PLUGIN_MANIFEST_FILENAME))
  if (looksLikePath(value) || localFolder) {
    return { kind: 'local-path', path: resolveHostPluginPath(ctx, value) }
  }
  if (!value.includes('/') && !value.includes(':') && isQualifiedPluginKey(value)) {
    return { kind: 'catalog', pluginKey: value, ...(catalog ? { catalog } : {}) }
  }
  if (catalog) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--catalog only applies to a catalog id such as acme.dusk.'
    )
  }
  // Why `@` only for owner/repo: in an SSH URL `@` already separates the user from the host.
  const shorthand = SHORTHAND_WITH_REF.exec(value)
  const input = shorthand ? `${shorthand[1]}#${shorthand[2]}` : value
  if (ref && input.includes('#')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass the version once: either @ref/#ref or --ref.'
    )
  }
  return { kind: 'git', input: ref ? `${input}#${ref}` : input }
}

function approvalText(approval: string): string {
  switch (approval) {
    case 'content-only':
      return 'content only, no approval needed'
    case 'approve-flag':
      return 'approved with --approve'
    case 'kept':
      return 'it asks for nothing new, so it kept its approval'
    case 'not-approved':
      return 'it was not enabled before, so it still is not'
    default:
      return 'already approved'
  }
}

function formatInstall(result: InstallResult, verb: string): string {
  const from =
    result.previousVersion && result.previousVersion !== result.version
      ? ` (was ${result.previousVersion})`
      : ''
  return [
    `${verb} ${result.pluginKey} ${result.version}${from}: ${approvalText(result.approval)}.`,
    ...pluginInstallSourceLines(result.source),
    result.plugin ? formatPluginRow(result.plugin) : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function formatUpdate(result: UpdateResult): string {
  return result.status === 'updated'
    ? formatInstall(result, 'Updated')
    : `${result.pluginKey} ${result.version} is ${result.status}: ${result.reason}`
}

function formatCatalog(entry: CatalogEntry): string {
  const tags = [entry.official ? 'official' : null, entry.stale ? 'stale' : null]
  return `${entry.id}  ${entry.name ?? '(not fetched)'}  ${entry.url} (${entry.ref})${tags.some(Boolean) ? `  ${tags.filter(Boolean).join(', ')}` : ''}${entry.error ? `\n  ${entry.error}` : ''}`
}

export const PLUGIN_INSTALL_HANDLERS: Record<string, CommandHandler> = {
  'plugin install': async (ctx) => {
    const source = classifyPluginInstallSource(ctx, requirePluginPathArg(ctx, 'source').trim())
    const result = await callPlugins<InstallResult>(
      ctx,
      'plugins.install',
      { source, approvalFingerprint: stringFlag(ctx, 'approve') },
      INSTALL_TIMEOUT
    )
    printPluginResult(ctx, result, formatInstall(result, 'Installed'))
  },
  'plugin update': async (ctx) => {
    const all = ctx.flags.get('all') === true
    if (all === (stringFlag(ctx, 'plugin') !== undefined)) {
      throw new RuntimeClientError('invalid_argument', 'Pass a plugin key or --all, not both.')
    }
    if (all) {
      const result = await callPlugins<{ updates: UpdateResult[] }>(
        ctx,
        'plugins.update',
        { all: true },
        INSTALL_TIMEOUT
      )
      printPluginResult(
        ctx,
        result,
        result.updates.length === 0
          ? 'No installed plugins.'
          : result.updates.map(formatUpdate).join('\n')
      )
      return
    }
    const result = await callPlugins<UpdateResult>(
      ctx,
      'plugins.update',
      { pluginKey: requirePluginKey(ctx), approvalFingerprint: stringFlag(ctx, 'approve') },
      INSTALL_TIMEOUT
    )
    printPluginResult(ctx, result, formatUpdate(result))
  },
  'plugin uninstall': async (ctx) => {
    const result = await callPlugins<{ pluginKey: string }>(ctx, 'plugins.uninstall', {
      pluginKey: requirePluginKey(ctx)
    })
    printPluginResult(ctx, result, `Uninstalled ${result.pluginKey}.`)
  },
  'plugin catalog list': async (ctx) => {
    const catalogs = await callPlugins<CatalogEntry[]>(ctx, 'plugins.catalogList')
    printPluginResult(
      ctx,
      { catalogs },
      catalogs.length === 0 ? 'No catalogs.' : catalogs.map(formatCatalog).join('\n')
    )
  },
  'plugin catalog add': async (ctx) => {
    const result = await callPlugins<{ added: boolean; catalog: CatalogEntry }>(
      ctx,
      'plugins.catalogAdd',
      {
        input: requirePluginPathArg(ctx, 'source').trim(),
        ref: stringFlag(ctx, 'ref'),
        approvalFingerprint: stringFlag(ctx, 'approve')
      },
      INSTALL_TIMEOUT
    )
    printPluginResult(
      ctx,
      result,
      `${result.added ? 'Added' : 'Refreshed'} catalog ${formatCatalog(result.catalog)}`
    )
  },
  'plugin catalog rm': async (ctx) => {
    const result = await callPlugins<{ removed: CatalogEntry }>(ctx, 'plugins.catalogRemove', {
      catalog: requirePluginPathArg(ctx, 'catalog').trim()
    })
    printPluginResult(ctx, result, `Removed catalog ${formatCatalog(result.removed)}`)
  }
}
