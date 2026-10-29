import { describe, expect, it } from 'vitest'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../shared/plugins/plugin-panel-bridge'
import { NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX } from '../../shared/native-chat/native-chat-visual-shell'
import { HostFrameNavigationRegistry, hostFrameKindForName } from './host-frame-navigation-guard'

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

describe('HostFrameNavigationRegistry', () => {
  it('blocks only host-marked plugin srcdoc frames', () => {
    const registry = new HostFrameNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    const notebook = frame({ id: 2 })
    registry.register(plugin)
    registry.register(notebook)

    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(true)
    expect(registry.shouldBlock(notebook, notebook, 'https://example.com')).toBe(false)
  })

  it('keeps pre-parse identity after name mutation and ignores destroyed frames', () => {
    const registry = new HostFrameNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    registry.register(plugin)
    plugin.name = ''
    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(true)

    plugin.destroy()
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(false)
  })

  it('contains chat visual frames the same way, as their own kind', () => {
    const registry = new HostFrameNavigationRegistry()
    const visual = frame({ id: 3, name: `${NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX}abc` })
    registry.register(visual)
    expect(hostFrameKindForName(visual.name)).toBe('chat-visual')
    expect(hostFrameKindForName(`${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo`)).toBe('plugin-panel')
    expect(hostFrameKindForName('orca-chat-visual')).toBeNull()

    expect(registry.shouldBlock(visual, null, 'about:srcdoc')).toBe(false)
    // Its own navigation (location, meta refresh, link) and any child it starts are refused.
    expect(registry.shouldBlock(visual, visual, 'https://example.com')).toBe(true)
    expect(registry.shouldBlock(visual, null, 'https://example.com')).toBe(true)
    const child = frame({ id: 4 })
    expect(registry.shouldBlock(child, visual, 'https://example.com')).toBe(true)
  })

  it('does not inspect unrelated guarded frames during registration or navigation', () => {
    const registry = new HostFrameNavigationRegistry()
    let livenessChecks = 0
    const panels = Array.from({ length: 100 }, (_, id) => ({
      ...frame({ id, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}${id}` }),
      isDestroyed: () => {
        livenessChecks++
        return false
      }
    }))
    for (const panel of panels) {
      registry.register(panel)
    }
    const ordinary = frame({ id: 101 })
    registry.register(ordinary)
    expect(registry.shouldBlock(ordinary, null, 'https://example.com')).toBe(false)
    expect(registry.shouldBlock(panels[0], null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(panels[0], panels[0], 'https://example.com')).toBe(true)
    expect(registry.shouldBlock(ordinary, panels[1], 'https://example.com')).toBe(true)
    expect(livenessChecks).toBeLessThanOrEqual(4)
  })
})
