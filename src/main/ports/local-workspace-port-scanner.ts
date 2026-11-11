import type { WorkspacePortProbe, WorkspacePortScanResult } from '../../shared/workspace-ports'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from './advertised-url-watcher'
import {
  attributePortsToWorkspaces,
  compareWorkspacePorts,
  enrichPort,
  resolveWorkspacePortProbes,
  reconcileAdvertisedUrls
} from './local-workspace-port-attribution'
import { scanPlatformListeningPorts } from './local-workspace-platform-port-scanner'
import { hostManagedListenerConfig, isHostManagedListener } from './host-managed-listeners'
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
  urlWatcher: Pick<AdvertisedUrlWatcher, 'lookup' | 'reconcileWorkspaces'> = advertisedUrlWatcher,
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
    const { ports: rawPorts, metadataAvailable } = await scanPlatformListeningPorts(options)
    recordWorkspacePortScanSuccess()
    const { probes: normalizedWorktrees, complete } = await resolveWorkspacePortProbes(
      worktrees,
      options.requireMetadata
    )
    const hostManaged = hostManagedListenerConfig()
    const managed = new Set(
      rawPorts
        .filter((port) => isHostManagedListener(port, hostManaged))
        .map((port) => `${port.host}:${port.port}:${port.pid ?? 'unknown'}`)
    )
    // Orca's own listeners (runtime socket, hook server) run with a workspace in their command line but are not its servers.
    const attributedPorts = attributePortsToWorkspaces(
      rawPorts.map((port) =>
        port.pid === process.pid ? { ...port, cwd: undefined, commandLine: undefined } : port
      ),
      normalizedWorktrees
    )
    // Missing metadata cannot prove listener loss; eviction would discard URLs only PTY output can restore (#11161).
    if (metadataAvailable && complete) {
      reconcileAdvertisedUrls(attributedPorts, normalizedWorktrees, urlWatcher)
    }
    const ports = attributedPorts
      .map((port) => {
        const enriched = enrichPort(port, urlWatcher)
        return managed.has(enriched.id) ? { ...enriched, hostManaged: true as const } : enriched
      })
      .sort(compareWorkspacePorts)
      .slice(0, MAX_PORTS)
    return { platform: process.platform, scannedAt: Date.now(), ports }
  } catch (error) {
    if (isWorkspacePortScanCommandTimeout(error)) {
      recordWorkspacePortScanTimeout()
    }
    warnWorkspacePortScanFailure(error)
    return makeUnavailableWorkspacePortScan(`Port scanning is unavailable on ${process.platform}.`)
  }
}
