import type { PluginHookName } from '../../../shared/plugins/contributions/plugin-hook-contribution'
import { isInvalidDiscoveredPlugin, type ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginEventDeliveryContext } from '../plugin-event-delivery'
import {
  runPluginHookChain,
  type PluginHookChainOutcome
} from '../../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner, type PluginHookRunner } from './plugin-hook-dispatch'
import type { PluginService } from '../plugin-service'

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

export function createPluginHookRunner(context: PluginHookHostContext): PluginHookRunner {
  return {
    wants: (event) => context.isEnabled() && pluginHookParticipants(event, context).length > 0,
    run: (event, payload): Promise<PluginHookChainOutcome> => {
      const participants = new Map(
        pluginHookParticipants(event, context).map((plugin) => [plugin.pluginKey, plugin])
      )
      return runPluginHookChain({
        event,
        payload,
        participants: [...participants.keys()],
        invoke: async (pluginKey, current, timeoutMs) => {
          const plugin = participants.get(pluginKey)
          // Why recheck: an earlier hook may have outlived this plugin's removal or disablement.
          if (!plugin || !context.isRuntimeApproved(plugin)) {
            throw new Error('the plugin is no longer enabled')
          }
          const worker = await context.ensureWorker(plugin)
          return worker.runHook(event, current, timeoutMs)
        },
        log: (pluginKey, line) => context.logWarning(pluginKey)(line),
        now: () => performance.now()
      })
    }
  }
}

/** Points Orca's hook sites at this service's plugins, through the same path events take. */
export function installPluginHookRunner(service: Pick<PluginService, 'eventDelivery' | 'options'>) {
  setPluginHookRunner(
    createPluginHookRunner({
      ...service.eventDelivery,
      isEnabled: () => service.options.isPluginSystemEnabled()
    })
  )
}
