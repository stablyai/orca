import type {
  Automation,
  AutomationUpdateInput
} from '../../shared/automations/automation-definition'
import type { PluginServiceOptions } from './plugin-service-options'
import { onPluginRemoved } from './installation/plugin-removal-events'

type PluginStateSource = {
  options: Pick<
    PluginServiceOptions,
    'isPluginSystemEnabled' | 'getDisabledPlugins' | 'getPluginKillListEntry'
  >
  whenReady(): Promise<void>
  onChanged(listener: () => void): () => void
}

type AutomationSource = {
  listAutomationsForScope(params: Record<string, never>): { automations: readonly Automation[] }
  updateAutomation(id: string, updates: AutomationUpdateInput): Promise<Automation>
}

/**
 * Whether the person took the plugin away from this automation: uninstalled it after creating it
 * (`removedAt`), disabled it or all plugins, or Orca blocked it. Only these settings and the
 * uninstall itself count; a plugin missing from a discovery (an unreadable folder, a failed scan)
 * keeps its automations.
 */
export function pluginOwnershipEnded(
  options: PluginStateSource['options'],
  removedAt: ReadonlyMap<string, number>,
  automation: Pick<Automation, 'createdAt'> & { createdBy: { pluginKey: string } }
): boolean {
  const pluginKey = automation.createdBy.pluginKey
  return (
    automation.createdAt <= (removedAt.get(pluginKey) ?? -Infinity) ||
    !options.isPluginSystemEnabled() ||
    options.getDisabledPlugins().includes(pluginKey) ||
    options.getPluginKillListEntry?.(pluginKey) != null
  )
}

/**
 * Pauses the automations of a plugin the person uninstalled or disabled, or Orca blocked, and ends
 * its ownership, so neither re-enabling it nor a later install under the same key resumes or edits
 * them without the person. Sweeps only once the plugin service has loaded.
 */
export function installPluginAutomationOwnershipEnd(
  service: PluginStateSource,
  automations: AutomationSource,
  log: (message: string) => void = console.warn
): () => void {
  // Why times: an install under the same key after the removal owns what it creates.
  const removedAt = new Map<string, number>()
  let ready = false
  let running = false
  let again = false
  const sweep = async (): Promise<void> => {
    if (!ready || running) {
      again = running
      return
    }
    running = true
    try {
      do {
        again = false
        const ended = automations.listAutomationsForScope({}).automations.filter(
          (automation) =>
            automation.createdBy?.kind === 'plugin' &&
            automation.createdBy.endedAt === undefined &&
            pluginOwnershipEnded(service.options, removedAt, {
              createdAt: automation.createdAt,
              createdBy: automation.createdBy
            })
        )
        const endedAt = Date.now()
        await Promise.all(
          ended.map((automation) =>
            automations
              .updateAutomation(automation.id, {
                enabled: false,
                ...(automation.createdBy ? { createdBy: { ...automation.createdBy, endedAt } } : {})
              })
              .catch((error: unknown) =>
                log(`[plugins] could not pause automation ${automation.id}: ${String(error)}`)
              )
          )
        )
      } while (again)
    } finally {
      running = false
    }
  }
  const stopChanges = service.onChanged(() => void sweep())
  const stopRemovals = onPluginRemoved((pluginKey) => {
    removedAt.set(pluginKey, Date.now())
    void sweep()
  })
  void service.whenReady().then(() => {
    ready = true
    void sweep()
  })
  return () => {
    stopChanges()
    stopRemovals()
  }
}
