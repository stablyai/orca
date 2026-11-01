import {
  PLUGIN_NOT_FOUND_CODE,
  PLUGIN_INVALID_CODE,
  PLUGIN_SYSTEM_DISABLED_CODE,
  PluginCliError
} from '../../shared/plugins/approval/plugin-cli-approval'
import {
  PLUGIN_EVENT_CAPABILITY,
  PLUGIN_EVENT_NAMES,
  PLUGIN_V1_EVENT_ALIASES,
  type PluginEventName
} from '../../shared/plugins/contributions/plugin-event-contribution'
import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../shared/plugins/events/plugin-events'
import { isInvalidDiscoveredPlugin, type DiscoveredPlugin } from './plugin-discovery'
import {
  discoveredAt,
  findLoadedDevFolder,
  type PluginDevFolderLookup,
  type PluginDevFolderTarget
} from './plugin-dev-folders'
import {
  deliverPluginEventToWorker,
  pluginEventSkipReason,
  type PluginEventDeliveryContext,
  type PluginEventSkipReason
} from './plugin-event-delivery'

export type PluginDevEmitService = PluginDevFolderLookup & {
  options: { isPluginSystemEnabled: () => boolean }
  eventDelivery: PluginEventDeliveryContext
  panelBridge: {
    publishEvent(event: PluginEventName, payload: unknown, only: { pluginKey: string }): number
  }
}

export type PluginDevEmitResult = {
  pluginKey: string
  event: PluginEventName
  /** `panels`: open panels of this plugin that subscribed with `orca.on(event)`. */
  delivered: { worker: boolean; panels: number }
}

const LOGS_HINT =
  'Handler errors appear in `orca plugin logs <plugin-key>` and `orca plugin dev watch`.'

function parseEventName(event: string): PluginEventName {
  const known = PLUGIN_EVENT_NAMES.find((name) => name === event)
  const resolved = known ?? PLUGIN_V1_EVENT_ALIASES.get(event)
  if (!resolved) {
    throw new PluginCliError('invalid_argument', `${event} is not an Orca plugin event.`, {
      events: [...PLUGIN_EVENT_NAMES],
      nextSteps: [`Pass one of: ${PLUGIN_EVENT_NAMES.join(', ')}.`]
    })
  }
  return resolved
}

/** The loaded development plugin `target` names; installed plugins are refused. */
export async function resolveDevPlugin(
  service: PluginDevFolderLookup,
  target: PluginDevFolderTarget,
  installedRefusal = 'dev emit only fires events at development plugins'
): Promise<DiscoveredPlugin> {
  const path = await findLoadedDevFolder(service, target)
  const plugin = path ? discoveredAt(service, path) : null
  if (plugin) {
    return plugin
  }
  const key = 'pluginKey' in target ? target.pluginKey : null
  if (key && service.getDiscovered().some((entry) => entry.pluginKey === key)) {
    throw new PluginCliError(
      'invalid_argument',
      `${key} is an installed plugin; ${installedRefusal}.`,
      { nextSteps: ['Load the plugin folder with `orca plugin dev load <dir>`, then retry.'] }
    )
  }
  throw new PluginCliError(PLUGIN_NOT_FOUND_CODE, 'That is not a loaded development plugin.', {
    loaded: [...service.options.getDevPluginPaths()],
    nextSteps: [
      'Pass the folder or the plugin key of a development plugin (`orca plugin list --json` marks them dev), or load it first with `orca plugin dev load <dir>`.'
    ]
  })
}

function skipError(
  plugin: DiscoveredPlugin,
  event: PluginEventName,
  reason: PluginEventSkipReason
): PluginCliError {
  const key = plugin.pluginKey
  switch (reason) {
    case 'invalid':
      return new PluginCliError(
        PLUGIN_INVALID_CODE,
        `${key} is invalid, so it receives no events.`,
        {
          nextSteps: ['Run `orca plugin validate <dir>` and fix the manifest.']
        }
      )
    case 'no-worker':
    case 'not-subscribed':
      return new PluginCliError('invalid_argument', `Nothing in ${key} listens for ${event}.`, {
        nextSteps: [
          `A worker hears it with { "on": "${event}" } in contributes.events; an open panel hears it once it calls orca.on('${event}', …). Either needs the ${PLUGIN_EVENT_CAPABILITY[event]} capability.`
        ]
      })
    case 'not-approved':
      return new PluginCliError(
        'invalid_argument',
        `${key} is not approved and enabled, so it receives no events.`,
        { nextSteps: ['Run `orca plugin dev load <dir>` and approve it with `--approve`.'] }
      )
    case 'not-granted':
      return new PluginCliError(
        'invalid_argument',
        `${key} was not granted ${PLUGIN_EVENT_CAPABILITY[event]}, which ${event} needs.`,
        { nextSteps: ['Add the capability, then reload with `orca plugin dev reload <dir>`.'] }
      )
  }
}

export function assertPluginSystemEnabled(service: {
  options: { isPluginSystemEnabled: () => boolean }
}): void {
  if (!service.options.isPluginSystemEnabled()) {
    throw new PluginCliError(
      PLUGIN_SYSTEM_DISABLED_CODE,
      'Plugins are turned off on this Orca host.',
      {
        nextSteps: ['Turn plugins on (Settings → Plugins, or `orca plugin system on`).']
      }
    )
  }
}

/** `orca plugin dev emit`: one event through the real delivery rules, at one development plugin. */
export async function emitPluginDevEvent(input: {
  service: PluginDevEmitService
  target: PluginDevFolderTarget
  event: string
  payload: unknown
}): Promise<PluginDevEmitResult> {
  const { service } = input
  assertPluginSystemEnabled(service)
  const event = parseEventName(input.event)
  const plugin = await resolveDevPlugin(service, input.target)
  const reason = pluginEventSkipReason(plugin, event, service.eventDelivery)
  if (isInvalidDiscoveredPlugin(plugin)) {
    throw skipError(plugin, event, 'invalid')
  }
  // Why these first: panels follow the same approval and capability rules as the worker.
  if (!service.eventDelivery.isRuntimeApproved(plugin)) {
    throw skipError(plugin, event, 'not-approved')
  }
  const granted = service.eventDelivery.grantedCapabilities(plugin.pluginKey)
  if (!granted?.includes(PLUGIN_EVENT_CAPABILITY[event])) {
    throw skipError(plugin, event, 'not-granted')
  }
  const projected = PLUGIN_EVENT_PAYLOAD_SCHEMAS[event].safeParse(input.payload ?? {})
  if (!projected.success) {
    const issues = projected.error.issues.map(
      (issue) => `${issue.path.join('.') || '(payload)'}: ${issue.message}`
    )
    throw new PluginCliError('invalid_argument', `--data is not a valid ${event} payload.`, {
      issues,
      nextSteps: [...issues, 'The host API reference lists every event payload.']
    })
  }
  const worker = reason === null
  if (worker) {
    try {
      await deliverPluginEventToWorker(plugin, event, projected.data, service.eventDelivery)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${plugin.pluginKey}'s worker did not start: ${message}. ${LOGS_HINT}`)
    }
  }
  const panels = service.panelBridge.publishEvent(event, projected.data, {
    pluginKey: plugin.pluginKey
  })
  if (!worker && panels === 0) {
    throw skipError(plugin, event, reason ?? 'not-subscribed')
  }
  return { pluginKey: plugin.pluginKey, event, delivered: { worker, panels } }
}
