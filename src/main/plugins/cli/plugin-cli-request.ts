import {
  PLUGIN_INVALID_CODE,
  PLUGIN_REQUEST_FAILED_CODE,
  PluginCliError
} from '../../../shared/plugins/approval/plugin-cli-approval'
import { PANEL_MESSAGE_MAX_BYTES } from '../../../shared/plugins/frames/plugin-frame-bridge'
import { structuredCloneMessageBytes } from '../../../shared/plugins/frames/plugin-panel-message-budget'
import type { PluginErrorCode } from '../../../shared/plugins/frames/plugin-protocol'
import type { PluginJsonValue } from '../../../shared/plugins/workers/plugin-host-api-storage-schemas'
import { PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS } from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import { assertPluginSystemEnabled, resolveDevPlugin } from '../development/plugin-dev-event-emit'
import type {
  PluginDevFolderLookup,
  PluginDevFolderTarget
} from '../development/plugin-dev-folders'
import {
  isInvalidDiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../discovery/plugin-discovery'
import type { PluginPanelRequest } from '../panels/plugin-panel-bridge'
import { PluginHostCallError } from '../workers/host-api/plugin-host-call-scope'

type PluginCliRequestService = PluginDevFolderLookup & {
  options: { isPluginSystemEnabled: () => boolean }
  findApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  panelBridge: { request(request: PluginPanelRequest): Promise<PluginJsonValue> }
}

type PluginCliRequestResult = { pluginKey: string; name: string; result: PluginJsonValue }

/** Panel id the handler sees when `--panel` is not passed. */
const CLI_PANEL_ID = 'orca-cli'

const LOGS_HINT = 'Worker errors appear in `orca plugin logs <plugin-key>`.'
const DEV_LOGS_HINT =
  'Worker errors appear in `orca plugin logs <plugin-key>` and `orca plugin dev watch`.'

function requestNextStep(code: PluginErrorCode, name: string, dev: boolean): string {
  const logs = dev ? DEV_LOGS_HINT : LOGS_HINT
  if (code === 'unknown_method') {
    const reload = dev ? '; a save restarts the worker with the new handlers' : ''
    return `Register it in the worker with orca.panels.handle('${name}', …)${reload}.`
  }
  if (code === 'timeout') {
    return 'The handler did not answer in time; pass a larger --timeout-ms (at most 120000) or make it answer sooner.'
  }
  if (code === 'unavailable') {
    return `The worker did not start or stopped. ${logs}`
  }
  return code === 'too_large' ? 'Answer with less than 1 MiB of JSON.' : logs
}

async function devPluginKey(
  service: PluginCliRequestService,
  target: PluginDevFolderTarget
): Promise<string> {
  const discovered = await resolveDevPlugin(
    service,
    target,
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
  return discovered.pluginKey
}

/** `orca plugin request` and `orca plugin dev request`: one `plugin.request` through the real panel → worker bridge. */
export async function requestPluginPanelHandler(input: {
  service: PluginCliRequestService
  target: { dev: PluginDevFolderTarget } | { installed: string }
  name: string
  input: PluginJsonValue | undefined
  panel?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<PluginCliRequestResult> {
  const { service, name, target } = input
  assertPluginSystemEnabled(service)
  const dev = 'dev' in target
  const key = dev ? await devPluginKey(service, target.dev) : target.installed
  const plugin = service.findApprovedPlugin(key)
  if (!plugin || plugin.isDev !== dev) {
    throw new PluginCliError(
      'invalid_argument',
      `${key} is not approved and enabled as ${dev ? 'a development' : 'an installed'} plugin.`,
      {
        nextSteps: [
          dev
            ? 'Run `orca plugin dev load <dir>` and approve it with `--approve`.'
            : 'Use `orca plugin list` to check the installed key and its approval.'
        ]
      }
    )
  }
  if (
    !dev &&
    !plugin.manifest.capabilities.some(
      (grant) => grant.kind === 'cli:request' && grant.handler === name
    )
  ) {
    throw new PluginCliError('invalid_argument', `${key} does not expose ${name} to the CLI.`, {
      nextSteps: ["Use a handler declared in the installed plugin's cli:request capabilities."]
    })
  }
  if (
    !dev &&
    structuredCloneMessageBytes(input.input ?? null, PANEL_MESSAGE_MAX_BYTES) >
      PANEL_MESSAGE_MAX_BYTES
  ) {
    throw new PluginCliError(
      'invalid_argument',
      'CLI handler input exceeds the panel request limit.',
      { nextSteps: ['Pass at most 64 KiB of JSON in --data.'] }
    )
  }
  if (!plugin.manifest.main) {
    throw new PluginCliError('invalid_argument', `${key} has no worker to answer ${name}.`, {
      nextSteps: [
        'Add "main" (a trusted-worker plugin) whose activate(orca) calls orca.panels.handle; `orca plugin create --template worker-panel` scaffolds one.'
      ]
    })
  }
  const panel = dev ? plugin.manifest.contributes.panels[0] : undefined
  try {
    const result = await service.panelBridge.request({
      pluginKey: key,
      caller: {
        id: input.panel ?? CLI_PANEL_ID,
        surface: 'panel',
        contributionId: panel?.id ?? CLI_PANEL_ID
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
      { requestCode: error.code, nextSteps: [requestNextStep(error.code, name, dev)] }
    )
  }
}
