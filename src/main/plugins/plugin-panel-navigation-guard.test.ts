import { describe, expect, it } from 'vitest'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../shared/plugins/plugin-panel-bridge'
import { PluginPanelNavigationRegistry } from './plugin-panel-navigation-guard'

function frame(input: { id: number; name?: string; url?: string }) {
  let destroyed = false
  return {
    frameTreeNodeId: input.id,
    name: input.name ?? '',
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    }
  }
}

describe('PluginPanelNavigationRegistry', () => {
  it('blocks only host-marked plugin srcdoc frames', () => {
    const registry = new PluginPanelNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    const notebook = frame({ id: 2 })
    registry.register(plugin)
    registry.register(notebook)

    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(true)
    expect(registry.shouldBlock(notebook, notebook, 'https://example.com')).toBe(false)
  })

  it('keeps pre-parse identity after name mutation and prunes destroyed frames', () => {
    const registry = new PluginPanelNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    registry.register(plugin)
    plugin.name = ''
    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(true)

    plugin.destroy()
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(false)
  })
})
