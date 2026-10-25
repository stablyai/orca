import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerSpawnSpec } from './plugin-worker-startup'

export function buildPluginWorkerSpawnSpec(
  plugin: ValidDiscoveredPlugin,
  grantedCapabilities: readonly PluginCapabilityKind[]
): PluginWorkerSpawnSpec {
  if (!plugin.manifest.main) {
    throw new Error(`plugin ${plugin.pluginKey} has no worker entry`)
  }
  return {
    pluginKey: plugin.pluginKey,
    rootDir: plugin.rootDir,
    mainEntry: plugin.manifest.main,
    // Dev roots survive manifest changes; include revision to prevent stale worker reuse.
    manifestRevision: JSON.stringify(plugin.manifest),
    grantedCapabilities
  }
}

export function pluginWorkerSpawnSpecsEqual(
  left: PluginWorkerSpawnSpec,
  right: PluginWorkerSpawnSpec
): boolean {
  if (
    left.pluginKey !== right.pluginKey ||
    left.rootDir !== right.rootDir ||
    left.mainEntry !== right.mainEntry ||
    left.manifestRevision !== right.manifestRevision
  ) {
    return false
  }
  const leftCapabilities = [...left.grantedCapabilities].sort()
  const rightCapabilities = [...right.grantedCapabilities].sort()
  return (
    leftCapabilities.length === rightCapabilities.length &&
    leftCapabilities.every((capability, index) => capability === rightCapabilities[index])
  )
}
