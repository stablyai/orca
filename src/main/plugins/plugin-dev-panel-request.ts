import {
  PLUGIN_INVALID_CODE,
  PLUGIN_REQUEST_FAILED_CODE,
  PluginCliError
} from '../../shared/plugins/approval/plugin-cli-approval'
import type { PluginErrorCode } from '../../shared/plugins/frames/plugin-protocol'
import type { PluginJsonValue } from '../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS } from '../../shared/plugins/workers/plugin-panel-bridge-protocol'
import { assertPluginSystemEnabled, resolveDevPlugin } from './plugin-dev-event-emit'
import type { PluginDevFolderLookup, PluginDevFolderTarget } from './plugin-dev-folders'
import { isInvalidDiscoveredPlugin, type ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginPanelRequest } from './panels/plugin-panel-bridge'
import { PluginHostCallError } from './workers/plugin-host-call-scope'

export type PluginDevRequestService = PluginDevFolderLookup & {
  options: { isPluginSystemEnabled: () => boolean }
  findApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  panelBridge: { request(request: PluginPanelRequest): Promise<PluginJsonValue> }
}

export type PluginDevRequestResult = { pluginKey: string; name: string; result: PluginJsonValue }

/** Panel id the handler sees when `--panel` is not passed. */
export const PLUGIN_DEV_REQUEST_PANEL_ID = 'orca-cli'

const LOGS_HINT =
  'Worker errors appear in `orca plugin logs <plugin-key>` and `orca plugin dev watch`.'

function requestNextStep(code: PluginErrorCode, name: string): string {
  if (code === 'unknown_method') {
    return `Register it in the worker with orca.panels.handle('${name}', …); a save restarts the worker with the new handlers.`
  }
  if (code === 'timeout') {
    return 'The handler did not answer in time; pass a larger --timeout-ms (at most 120000) or make it answer sooner.'
  }
  if (code === 'unavailable') {
    return `The worker did not start or stopped. ${LOGS_HINT}`
  }
  return code === 'too_large' ? 'Answer with less than 1 MiB of JSON.' : LOGS_HINT
}

/** `orca plugin dev request`: one `plugin.request` through the real panel → worker bridge. */
export async function requestPluginDevPanelHandler(input: {
  service: PluginDevRequestService
  target: PluginDevFolderTarget
  name: string
  input: PluginJsonValue | undefined
  panel?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<PluginDevRequestResult> {
  const { service, name } = input
  assertPluginSystemEnabled(service)
  const discovered = await resolveDevPlugin(
    service,
    input.target,
    'dev request only reaches development plugins'
  )
  if (isInvalidDiscoveredPlugin(discovered)) {
    throw new PluginCliError(
      PLUGIN_INVALID_CODE,
      'That plugin is invalid, so its worker cannot run.',
      {
        nextSteps: ['Run `orca plugin validate <dir>` and fix the manifest.']
      }
    )
  }
  const key = discovered.pluginKey
  const plugin = service.findApprovedPlugin(key)
  if (!plugin) {
    throw new PluginCliError(
      'invalid_argument',
      `${key} is not approved and enabled, so its worker cannot run.`,
      { nextSteps: ['Run `orca plugin dev load <dir>` and approve it with `--approve`.'] }
    )
  }
  if (!plugin.manifest.main) {
    throw new PluginCliError('invalid_argument', `${key} has no worker to answer ${name}.`, {
      nextSteps: [
        'Add "main" (a trusted-worker plugin) whose activate(orca) calls orca.panels.handle; `orca plugin create --template worker-panel` scaffolds one.'
      ]
    })
  }
  const panel = plugin.manifest.contributes.panels[0]
  try {
    const result = await service.panelBridge.request({
      pluginKey: key,
      caller: {
        id: input.panel ?? PLUGIN_DEV_REQUEST_PANEL_ID,
        surface: 'panel',
        contributionId: panel?.id ?? PLUGIN_DEV_REQUEST_PANEL_ID
      },
      name,
      // Why null: a panel's plugin.request(name) with no input reaches the handler as null.
      input: input.input ?? null,
      timeoutMs: input.timeoutMs ?? PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS,
      // Why own signal: the bridge would otherwise keep a lifetime for a panel that never closes.
      signal: input.signal ?? new AbortController().signal
    })
    return { pluginKey: key, name, result }
  } catch (error) {
    if (!(error instanceof PluginHostCallError)) {
      throw error
    }
    throw new PluginCliError(
      PLUGIN_REQUEST_FAILED_CODE,
      `${key} answered ${name} with ${error.code}: ${error.message}`,
      { requestCode: error.code, nextSteps: [requestNextStep(error.code, name)] }
    )
  }
}
