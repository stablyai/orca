import type {
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace/ports/workspace-ports'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from './advertised-url-watcher'
import {
  attributePortsToWorkspaces,
  compareWorkspacePorts,
  enrichPort,
  resolveWorkspacePortProbes,
  reconcileAdvertisedUrls,
  workspaceListenerObservations
} from './local-workspace-port-attribution'
import { scanPlatformListeningPorts } from './local-workspace-platform-port-scanner'
import {
  getWorkspacePortScanCooldown,
  isWorkspacePortScanCommandTimeout,
  makeUnavailableWorkspacePortScan,
  recordWorkspacePortScanSuccess,
  recordWorkspacePortScanTimeout,
  warnWorkspacePortScanFailure,
  type WorkspacePortScanOptions
} from './local-workspace-port-scan-state'
const MAX_PORTS = 200

export async function scanWorkspacePorts(
  worktrees: WorkspacePortProbe[],
  urlWatcher: Pick<
    AdvertisedUrlWatcher,
    'lookup' | 'reconcileWorkspaces' | 'couldDropUrls'
  > = advertisedUrlWatcher,
  options: WorkspacePortScanOptions = {}
): Promise<WorkspacePortScanResult> {
  const cooldown = getWorkspacePortScanCooldown()
  if (cooldown.isCoolingDown) {
    return makeUnavailableWorkspacePortScan(
      `Port scanning is temporarily paused after a command timeout. Retrying in ${Math.ceil(
        cooldown.remainingMs / 1000
      )}s.`
    )
  }

  try {
    let freshOwners = false
    let resolved: Awaited<ReturnType<typeof resolveWorkspacePortProbes>> | undefined
    for (;;) {
      const scan = await scanPlatformListeningPorts({ ...options, freshOwners })
      recordWorkspacePortScanSuccess()
      resolved ??= await resolveWorkspacePortProbes(worktrees, options.requireMetadata)
      const { probes, complete } = resolved
      const attributedPorts = attributePortsToWorkspaces(scan.ports, probes)
      // Cached owners can miss a socket passed to a running process; only a full walk may drop a printed URL.
      if (
        !freshOwners &&
        scan.ownersFromCache &&
        urlWatcher.couldDropUrls(workspaceListenerObservations(attributedPorts, probes))
      ) {
        freshOwners = true
        continue
      }
      // Missing metadata cannot prove listener loss; eviction would discard URLs only PTY output can restore (#11161).
      if (scan.metadataAvailable && complete) {
        reconcileAdvertisedUrls(attributedPorts, probes, urlWatcher)
      }
      const ports = attributedPorts
        .map((port) => enrichPort(port, urlWatcher))
        .sort(compareWorkspacePorts)
        .slice(0, MAX_PORTS)
      return { platform: process.platform, scannedAt: Date.now(), ports }
    }
  } catch (error) {
    if (isWorkspacePortScanCommandTimeout(error)) {
      recordWorkspacePortScanTimeout()
    }
    warnWorkspacePortScanFailure(error)
    return makeUnavailableWorkspacePortScan(`Port scanning is unavailable on ${process.platform}.`)
  }
}
