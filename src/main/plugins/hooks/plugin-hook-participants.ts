import {
  PLUGIN_HOOK_NAMES,
  type PluginHookName
} from '../../../shared/plugins/contributions/plugin-hook-contribution'
import { isInvalidDiscoveredPlugin, type ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginEventDeliveryContext } from '../plugin-event-delivery'
import {
  runPluginHookChain,
  type PluginHookChainOutcome
} from '../../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner, type PluginHookRunner } from './plugin-hook-dispatch'
import type { PluginService } from '../plugin-service'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'
import { PLUGIN_WORKER_READY_TIMEOUT_MS } from '../../../shared/plugins/workers/plugin-host-protocol'

/** The event path's context (enabled, approved, not being removed; worker start; logs). */
export type PluginHookHostContext = Pick<
  PluginEventDeliveryContext,
  'plugins' | 'isRuntimeApproved' | 'ensureWorker' | 'logWarning'
> & { isEnabled: () => boolean }

/** Plugins Orca waits on for `event`: installed ones by key (stable on every platform), then
 *  development folders in the order they were added. */
export function pluginHookParticipants(
  event: PluginHookName,
  context: Pick<PluginHookHostContext, 'plugins' | 'isRuntimeApproved'>
): ValidDiscoveredPlugin[] {
  const listed = context
    .plugins()
    .filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        plugin.manifest.main !== undefined &&
        plugin.manifest.contributes.hooks.some((hook) => hook.event === event) &&
        context.isRuntimeApproved(plugin)
    )
  const installed = listed
    .filter((plugin) => !plugin.isDev)
    .sort((a, b) => (a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0))
  return [...installed, ...listed.filter((plugin) => plugin.isDev)]
}

/** What makes a plugin the one the person approved: a change means a new revision. */
function pluginHookRevision(plugin: ValidDiscoveredPlugin): string {
  return [
    plugin.consentFingerprint,
    plugin.contentHash ?? '',
    plugin.devRevision ?? '',
    plugin.rootDir
  ].join('\n')
}

function isSamePluginStillEnabled(
  plugin: ValidDiscoveredPlugin,
  context: Pick<PluginHookHostContext, 'plugins' | 'isRuntimeApproved' | 'isEnabled'>
): boolean {
  const current = context.plugins().find((candidate) => candidate.pluginKey === plugin.pluginKey)
  return (
    context.isEnabled() &&
    current !== undefined &&
    !isInvalidDiscoveredPlugin(current) &&
    pluginHookRevision(current) === pluginHookRevision(plugin) &&
    context.isRuntimeApproved(current)
  )
}

export function createPluginHookRunner(context: PluginHookHostContext): PluginHookRunner {
  return {
    wants: (event) => context.isEnabled() && pluginHookParticipants(event, context).length > 0,
    run: (event, payload): Promise<PluginHookChainOutcome> => {
      const participants = new Map(
        pluginHookParticipants(event, context).map((plugin) => [plugin.pluginKey, plugin])
      )
      const workers = new Map<string, PluginWorkerHandle>()
      return runPluginHookChain({
        event,
        payload,
        participants: [...participants.keys()],
        start: async (pluginKey) => {
          const plugin = participants.get(pluginKey)
          // Why recheck: an earlier hook may have outlived this plugin's removal or disablement.
          if (!plugin || !context.isRuntimeApproved(plugin)) {
            throw new Error('the plugin is no longer enabled')
          }
          workers.set(pluginKey, await context.ensureWorker(plugin))
        },
        // Why the ready timeout: a start (normally done ahead by warming) is not handler time.
        startTimeoutMs: PLUGIN_WORKER_READY_TIMEOUT_MS,
        invoke: async (pluginKey, current, timeoutMs) => {
          const worker = workers.get(pluginKey)
          const plugin = participants.get(pluginKey)
          if (!worker || !plugin) {
            throw new Error('the worker is not running')
          }
          const decision = await worker.runHook(event, current, timeoutMs)
          // Why: a plugin disabled, removed or updated while it decided no longer speaks for Orca.
          if (!isSamePluginStillEnabled(plugin, context)) {
            throw new Error('the plugin was disabled or changed while its hook ran')
          }
          return decision
        },
        log: (pluginKey, line) => context.logWarning(pluginKey)(line),
        now: () => performance.now()
      })
    }
  }
}

/**
 * Starts the workers of enabled plugins that list hooks, so the first hooked action never waits
 * on (or slips past) a cold start. Once per approved revision: crash restarts follow the worker
 * manager's own policy, and a worker it marked errored stays down until the plugin changes.
 */
export function createPluginHookWarmer(
  context: Pick<
    PluginHookHostContext,
    'plugins' | 'isRuntimeApproved' | 'ensureWorker' | 'isEnabled'
  >
): () => void {
  const warmed = new Map<string, string>()
  return () => {
    const hooked = context.isEnabled()
      ? PLUGIN_HOOK_NAMES.flatMap((event) => pluginHookParticipants(event, context))
      : []
    const keys = new Set(hooked.map((plugin) => plugin.pluginKey))
    for (const pluginKey of warmed.keys()) {
      if (!keys.has(pluginKey)) {
        warmed.delete(pluginKey)
      }
    }
    for (const plugin of hooked) {
      const revision = pluginHookRevision(plugin)
      if (warmed.get(plugin.pluginKey) === revision) {
        continue
      }
      warmed.set(plugin.pluginKey, revision)
      // Why swallow: ensure records the activation error the plugin page shows.
      void context.ensureWorker(plugin).catch(() => undefined)
    }
  }
}

/** Points Orca's hook sites at this service's plugins, through the same path events take, and
 *  keeps hook plugins' workers started as plugins change. */
export function installPluginHookRunner(
  service: Pick<PluginService, 'eventDelivery' | 'options' | 'onChanged'>
): void {
  const context = {
    ...service.eventDelivery,
    isEnabled: () => service.options.isPluginSystemEnabled()
  }
  setPluginHookRunner(createPluginHookRunner(context))
  service.onChanged(createPluginHookWarmer(context))
}
