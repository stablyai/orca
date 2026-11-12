import type {
  Automation,
  AutomationUpdateInput
} from '../../shared/automations/automation-definition'
import type { PluginServiceOptions } from './plugin-service-options'

type PluginStateSource = {
  options: Pick<
    PluginServiceOptions,
    'isPluginSystemEnabled' | 'getDisabledPlugins' | 'getPluginKillListEntry'
  >
  getDiscovered(): readonly { pluginKey?: string }[]
  onChanged(listener: () => void): () => void
}

type AutomationSource = {
  listAutomationsForScope(params: Record<string, never>): { automations: readonly Automation[] }
  updateAutomation(id: string, updates: AutomationUpdateInput): Promise<Automation>
}

/**
 * Whether the person took the plugin away: removed it, disabled it (or all plugins), or Orca
 * blocked it. A plugin waiting for re-approval, or whose folder failed to load, keeps its own.
 */
export function pluginOwnershipEnded(service: PluginStateSource, pluginKey: string): boolean {
  const { options } = service
  return (
    !options.isPluginSystemEnabled() ||
    options.getDisabledPlugins().includes(pluginKey) ||
    options.getPluginKillListEntry?.(pluginKey) != null ||
    !service.getDiscovered().some((plugin) => plugin.pluginKey === pluginKey)
  )
}

/**
 * Pauses the automations of a plugin the person removed, disabled or Orca blocked, and ends its
 * ownership, so neither re-enabling it nor a later install under the same key resumes or edits
 * them without the person. Runs after each plugin change; discovery has finished by then.
 */
export function installPluginAutomationOwnershipEnd(
  service: PluginStateSource,
  automations: AutomationSource,
  log: (message: string) => void = console.warn
): () => void {
  let running = false
  let again = false
  const sweep = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const ended = automations
          .listAutomationsForScope({})
          .automations.filter(
            (automation) =>
              automation.createdBy?.kind === 'plugin' &&
              automation.createdBy.endedAt === undefined &&
              pluginOwnershipEnded(service, automation.createdBy.pluginKey)
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
  return service.onChanged(() => void sweep())
}
