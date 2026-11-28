import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import type { ValidDiscoveredPlugin } from '../../discovery/plugin-discovery'
import type { PluginWorkerSpawnSpec } from '../worker-supervision/plugin-worker-startup'
import { pluginNeedsResidentWorker } from './plugin-resident-worker'

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
    // Why not a dev folder's consent hash: that names only its manifest and recipes, not its code.
    reviewedContentHash: plugin.contentHash,
    ...(plugin.isDev ? { devRevision: plugin.devRevision ?? null, allowProposed: true } : {}),
    ...(pluginNeedsResidentWorker(plugin.manifest) ? { keepWarm: true as const } : {}),
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
    left.manifestRevision !== right.manifestRevision ||
    (left.reviewedContentHash ?? null) !== (right.reviewedContentHash ?? null) ||
    (left.devRevision ?? null) !== (right.devRevision ?? null)
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
