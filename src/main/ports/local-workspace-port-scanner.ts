import type { WorkspacePortProbe, WorkspacePortScanResult } from '../../shared/workspace-ports'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from './advertised-url-watcher'
import {
  compareWorkspacePorts,
  enrichPort,
  normalizeWorkspacePortProbes,
  reconcileAdvertisedUrls
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
  urlWatcher: Pick<AdvertisedUrlWatcher, 'lookup' | 'reconcileScan'> = advertisedUrlWatcher,
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
    const normalizedWorktrees = normalizeWorkspacePortProbes(worktrees)
    // Missing metadata cannot prove listener loss; eviction would discard URLs only PTY output can restore (#11161).
    if (metadataAvailable) {
      reconcileAdvertisedUrls(rawPorts, normalizedWorktrees, urlWatcher)
    }
    const ports = rawPorts
      .map((port) => enrichPort(port, normalizedWorktrees, urlWatcher))
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
