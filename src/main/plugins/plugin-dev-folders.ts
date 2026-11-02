import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  PLUGIN_INVALID_CODE,
  PLUGIN_NOT_FOUND_CODE,
  PLUGIN_SYSTEM_DISABLED_CODE,
  PluginApprovalRequiredError,
  PluginCliError
} from '../../shared/plugins/approval/plugin-cli-approval'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'
import {
  approvePluginFromCli,
  type PluginCliApprovalOutcome,
  type PluginCliApprovalService
} from './plugin-cli-approval'
import { isInvalidDiscoveredPlugin, type DiscoveredPlugin } from './plugin-discovery'

export type PluginDevFolderService = PluginCliApprovalService & {
  options: PluginCliApprovalService['options'] & {
    isPluginSystemEnabled: () => boolean
    getDevPluginPaths: () => string[]
  }
  refresh: () => Promise<void>
  getDiscovered: () => readonly DiscoveredPlugin[]
}

export type PluginDevFolderWrites = {
  setDevPluginPaths: (paths: string[]) => void
  applyConsent: (request: PluginConsentRequest) => Promise<void>
}

export type PluginDevLoadResult = {
  path: string
  pluginKey: string
  /** False when the folder was already loaded and this only reloaded it. A folder added by a
   *  load that was refused (approval or invalid) counts as added by the next load that succeeds. */
  added: boolean
  approval: PluginCliApprovalOutcome
}

type PluginDevLoadInput = {
  service: PluginDevFolderService
  writes: PluginDevFolderWrites
  path: string
  approvalFingerprint?: string
  caller: RpcCallerIdentity | undefined
}

function assertPluginSystemEnabled(service: PluginDevFolderService): void {
  if (!service.options.isPluginSystemEnabled()) {
    throw new PluginCliError(
      PLUGIN_SYSTEM_DISABLED_CODE,
      'Plugins are turned off on this Orca host.',
      {
        nextSteps: [
          'Ask the user to click "Turn on plugins" in Orca Settings → Plugins (or, on a host with no window such as `orca serve`, to run `orca plugin system on` against it), then run the command again.'
        ]
      }
    )
  }
}

async function samePath(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

/** Host-local folder identity; the caller's string is resolved here, on the machine that loads it. */
async function resolveDevFolder(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new PluginCliError(
      'invalid_argument',
      `${path} is not an absolute path on the Orca host.`,
      {
        nextSteps: ['Pass the plugin folder as an absolute path on the machine that runs Orca.']
      }
    )
  }
  const real = await realpath(path).catch(() => null)
  if (!real || !(await stat(real)).isDirectory()) {
    throw new PluginCliError('invalid_argument', `${path} is not a folder on the Orca host.`, {
      nextSteps: ['Check the path; development folders must be on the machine that runs Orca.']
    })
  }
  return real
}

async function findStoredPath(stored: readonly string[], real: string): Promise<string | null> {
  for (const entry of stored) {
    if (entry === real || (await samePath(entry)) === real) {
      return entry
    }
  }
  return null
}

// Why per service and in memory: `dev watch` re-run with --approve must own (and on Ctrl-C remove)
// the folder its refused first attempt added; after a restart the folder reads as loaded before.
const refusedAdds = new WeakMap<PluginDevFolderService, Set<string>>()

function refusedAddsOf(service: PluginDevFolderService): Set<string> {
  let paths = refusedAdds.get(service)
  if (!paths) {
    paths = new Set()
    refusedAdds.set(service, paths)
  }
  return paths
}

export function discoveredAt(
  service: Pick<PluginDevFolderLookup, 'getDiscovered'>,
  path: string
): DiscoveredPlugin | null {
  return service.getDiscovered().find((plugin) => plugin.isDev && plugin.rootDir === path) ?? null
}

/**
 * Adds a development folder (the same list Settings → Plugins edits) and applies approval rules:
 * content-only plugins run at once; anything else stays loaded but inert until approved.
 */
export async function loadPluginDevFolder(input: PluginDevLoadInput): Promise<PluginDevLoadResult> {
  const { service } = input
  assertPluginSystemEnabled(service)
  const real = await resolveDevFolder(input.path)
  const stored = service.options.getDevPluginPaths()
  const existing = await findStoredPath(stored, real)
  const path = existing ?? real
  if (!existing) {
    input.writes.setDevPluginPaths([...stored, real])
  }
  const pending = refusedAddsOf(service)
  const added = !existing || pending.has(path)
  try {
    const result = await loadAddedDevFolder(input, path, added)
    pending.delete(path)
    return result
  } catch (error) {
    if (added) {
      pending.add(path)
    }
    throw error
  }
}

async function loadAddedDevFolder(
  input: PluginDevLoadInput,
  path: string,
  added: boolean
): Promise<PluginDevLoadResult> {
  const { service } = input
  await service.refresh()
  const plugin = discoveredAt(service, path)
  if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
    const error = plugin && isInvalidDiscoveredPlugin(plugin) ? plugin.error : 'no plugin found'
    throw new PluginCliError(PLUGIN_INVALID_CODE, `${path} did not load: ${error}`, {
      path,
      error,
      nextSteps: [
        'Run `orca plugin validate <dir>` for every problem, fix them, then `orca plugin dev reload <dir>`.',
        'The folder stays in the development list; `orca plugin dev unload <dir>` removes it.'
      ]
    })
  }
  try {
    const approval = await approvePluginFromCli({
      service,
      applyConsent: input.writes.applyConsent,
      pluginKey: plugin.pluginKey,
      approvalFingerprint: input.approvalFingerprint,
      action: 'dev-load',
      caller: input.caller
    })
    return { path, pluginKey: plugin.pluginKey, added, approval }
  } catch (error) {
    if (error instanceof PluginApprovalRequiredError) {
      throw new PluginApprovalRequiredError(
        {
          ...error.data,
          nextSteps: [
            ...error.data.nextSteps,
            'Until then the folder stays loaded but nothing in it runs; `orca plugin dev unload <dir>` removes it.'
          ]
        },
        error.code !== 'approval_required'
      )
    }
    throw error
  }
}

export type PluginDevFolderTarget = { path: string } | { pluginKey: string }
export type PluginDevFolderLookup = {
  options: { getDevPluginPaths: () => string[] }
  getDiscovered: () => readonly DiscoveredPlugin[]
}

/** The stored development folder a path or plugin key names, or null when none is loaded. */
export async function findLoadedDevFolder(
  service: PluginDevFolderLookup,
  target: PluginDevFolderTarget
): Promise<string | null> {
  const stored = service.options.getDevPluginPaths()
  if ('pluginKey' in target) {
    return (
      service
        .getDiscovered()
        .find(
          (plugin) =>
            plugin.isDev && plugin.pluginKey === target.pluginKey && stored.includes(plugin.rootDir)
        )?.rootDir ?? null
    )
  }
  return isAbsolute(target.path) ? findStoredPath(stored, await samePath(target.path)) : null
}

/** Removing a development folder only takes access away, so it never needs approval. */
export async function unloadPluginDevFolder(input: {
  service: PluginDevFolderService
  writes: Pick<PluginDevFolderWrites, 'setDevPluginPaths'>
  target: PluginDevFolderTarget
}): Promise<{ path: string; pluginKey: string | null }> {
  const { service } = input
  const stored = service.options.getDevPluginPaths()
  const path = await findLoadedDevFolder(service, input.target)
  if (!path) {
    throw new PluginCliError(
      PLUGIN_NOT_FOUND_CODE,
      'That folder is not a loaded development folder.',
      {
        loaded: [...stored],
        nextSteps: [
          'Pass the absolute folder path or plugin key shown by `orca plugin list --json`.'
        ]
      }
    )
  }
  const pluginKey = discoveredAt(service, path)?.pluginKey ?? null
  refusedAddsOf(service).delete(path)
  input.writes.setDevPluginPaths(stored.filter((entry) => entry !== path))
  await service.refresh()
  return { path, pluginKey }
}
