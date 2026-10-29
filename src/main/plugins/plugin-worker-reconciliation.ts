import { capabilityKinds } from '../../shared/plugins/plugin-capabilities'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { isInvalidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerSpawnSpec } from './plugin-worker-manager'
import { buildPluginWorkerSpawnSpec, pluginWorkerSpawnSpecsEqual } from './plugin-worker-spawn-spec'

export function isApprovedWorkerSpec(
  spec: PluginWorkerSpawnSpec,
  plugin: ValidDiscoveredPlugin | null
): boolean {
  return Boolean(
    plugin?.manifest.main &&
    pluginWorkerSpawnSpecsEqual(
      spec,
      buildPluginWorkerSpawnSpec(plugin, capabilityKinds(plugin.manifest.capabilities))
    )
  )
}

export function collectApprovedWorkerSpecs(
  plugins: readonly DiscoveredPlugin[],
  isApproved: (plugin: ValidDiscoveredPlugin) => boolean
): ReadonlyMap<string, PluginWorkerSpawnSpec> {
  const specs = new Map<string, PluginWorkerSpawnSpec>()
  for (const plugin of plugins) {
    if (isInvalidDiscoveredPlugin(plugin) || !plugin.manifest.main || !isApproved(plugin)) {
      continue
    }
    specs.set(
      plugin.pluginKey,
      buildPluginWorkerSpawnSpec(plugin, capabilityKinds(plugin.manifest.capabilities))
    )
  }
  return specs
}
