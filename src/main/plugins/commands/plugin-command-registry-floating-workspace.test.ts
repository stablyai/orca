import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { PluginCommandRegistry } from './plugin-command-registry'

function plugin(
  id: string,
  command: { id: string; title: string; action?: string },
  key: string
): ValidDiscoveredPlugin {
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher: 'samples',
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.4.160' },
    pluginApi: 1,
    capabilities: [],
    contributes: { commands: [command], keybindings: [{ command: command.id, key }] }
  })
  return {
    pluginKey: `samples.${id}`,
    rootDir: `/plugins/samples.${id}`,
    manifest,
    consentFingerprint: id,
    contentHash: id,
    isDev: false
  }
}

const inertAlias = plugin(
  'maximizer',
  { id: 'max', title: 'Maximize', action: 'floatingWorkspace.maximize' },
  'Mod+Alt+K'
)
const unrelated = plugin(
  'sidebar',
  { id: 'side', title: 'Sidebar', action: 'sidebar.left.toggle' },
  'Mod+Alt+K'
)

describe('plugin command chords while the floating workspace is inactive', () => {
  it('does not fault an unrelated plugin that shares a chord with an inert floating alias', () => {
    const registry = new PluginCommandRegistry()
    registry.reconcile([inertAlias, unrelated], () => true, {}, 'darwin', false)
    expect(registry.error(unrelated.pluginKey)).toBeNull()
    expect(registry.list().map((command) => command.id)).toContain('side')

    registry.reconcile([inertAlias, unrelated], () => true, {}, 'darwin', true)
    expect(registry.error(unrelated.pluginKey)).toMatch(/conflicts with another plugin/)
  })
})
