import { describe, expect, it } from 'vitest'
import { PluginTaskSourceRegistry } from './plugin-task-source-registry'
import type { DiscoveredPlugin } from './plugin-discovery'

function plugin(pluginKey: string, sourceIds: string[]): DiscoveredPlugin {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the
  // registry reads only pluginKey and contributes.taskSources from a discovered plugin.
  return {
    pluginKey,
    rootDir: `/plugins/${pluginKey}`,
    manifest: {
      main: 'main.mjs',
      contributes: {
        taskSources: sourceIds.map((id) => ({ id, title: `Title ${id}`, icon: 'kanban' }))
      }
    }
  } as unknown as DiscoveredPlugin
}

describe('PluginTaskSourceRegistry', () => {
  it('registers sources of approved plugins only', () => {
    const registry = new PluginTaskSourceRegistry()

    registry.reconcile(
      [plugin('acme.boards', ['azure-boards']), plugin('acme.other', ['other'])],
      (candidate) => candidate.pluginKey === 'acme.boards'
    )

    expect(registry.list()).toEqual([
      {
        pluginKey: 'acme.boards',
        sourceId: 'azure-boards',
        title: 'Title azure-boards',
        icon: 'kanban'
      }
    ])
  })

  it('finds a source by plugin key and id, and misses across plugins', () => {
    const registry = new PluginTaskSourceRegistry()
    registry.reconcile([plugin('acme.boards', ['azure-boards'])], () => true)

    expect(registry.find('acme.boards', 'azure-boards')).not.toBeNull()
    expect(registry.find('acme.other', 'azure-boards')).toBeNull()
  })

  it('drops sources when a plugin is no longer approved', () => {
    const registry = new PluginTaskSourceRegistry()
    const discovered = [plugin('acme.boards', ['azure-boards'])]

    registry.reconcile(discovered, () => true)
    registry.reconcile(discovered, () => false)

    expect(registry.list()).toEqual([])
  })
})
