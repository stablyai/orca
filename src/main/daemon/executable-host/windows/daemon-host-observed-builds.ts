import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { DaemonHostSources } from './daemon-host-manifest'

const observedBuilds = new Map<string, { fingerprint: string; entrySourcePath: string }>()

function observedBuildKey(sources: Pick<DaemonHostSources, 'execPath' | 'resourcesPath'>): string {
  return JSON.stringify([
    getAppEnvironment().getVersion(),
    sources.execPath,
    sources.resourcesPath,
    process.versions.electron ?? `node-${process.versions.node}`,
    process.arch
  ])
}

export function currentBuildFingerprint(
  sources: DaemonHostSources,
  sourceFingerprint: string | null
): string | null {
  const key = observedBuildKey(sources)
  if (sourceFingerprint !== null) {
    observedBuilds.set(key, {
      fingerprint: sourceFingerprint,
      entrySourcePath: sources.entrySourcePath
    })
    return sourceFingerprint
  }
  // Reuse the observed fingerprint after source removal; app version alone cannot select a build.
  const observed = observedBuilds.get(key)
  return observed?.entrySourcePath === sources.entrySourcePath ? observed.fingerprint : null
}

export function observedEntrySourcePath(
  sources: Pick<DaemonHostSources, 'execPath' | 'resourcesPath'>
): string | undefined {
  return observedBuilds.get(observedBuildKey(sources))?.entrySourcePath
}
