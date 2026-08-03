import type { WorkspacePort, WorkspacePortProbe } from '../../shared/workspace-ports'
import type { WorkspaceService, WorkspaceServiceScanResult } from '../../shared/workspace-services'
import {
  indexDockerContainersByHostPort,
  scanDockerContainerServices,
  type DockerContainerService
} from './docker-compose-services'
import { attributePortToWorkspace, scanWorkspacePorts } from './local-workspace-port-scanner'
import {
  readProcessAncestryTable,
  resolveServiceLaunchOrigin,
  type ProcessAncestryTable
} from './service-process-ancestry'
import { resolveServiceIdentity } from './service-project-identity'
import { isMissingDirectory } from './workspace-directory-presence'

/**
 * Compose a services view from the three independent sources.
 *
 * The OS port scan is the only source of truth for what is listening; docker
 * and the process table are enrichment. Each is gathered concurrently and each
 * degrades on its own, so a missing docker daemon or an unreadable process
 * table costs a column rather than the whole panel.
 */
export async function scanWorkspaceServices(
  worktrees: WorkspacePortProbe[]
): Promise<WorkspaceServiceScanResult> {
  const [portScan, dockerScan, ancestry] = await Promise.all([
    scanWorkspacePorts(worktrees),
    scanDockerContainerServices(),
    readProcessAncestryTable()
  ])

  const containersByPort = indexDockerContainersByHostPort(dockerScan.containers)
  const services = await Promise.all(
    portScan.ports.map((port) =>
      composeService(port, containersByPort.get(port.port), ancestry, worktrees)
    )
  )

  // A container whose host port has no local listener still matters: on some
  // docker backends the published port is held by a proxy the scan attributes
  // elsewhere, and dropping it would hide the container entirely.
  const seenPorts = new Set(portScan.ports.map((port) => port.port))
  const containerOnly = await Promise.all(
    [...containersByPort]
      .filter(([port]) => !seenPorts.has(port))
      .map(([port, container]) => composeContainerOnlyService(port, container, worktrees))
  )
  services.push(...containerOnly)

  return {
    platform: portScan.platform,
    scannedAt: portScan.scannedAt,
    services: services.sort(compareServices),
    dockerAvailable: dockerScan.available,
    ...(portScan.unavailableReason ? { unavailableReason: portScan.unavailableReason } : {}),
    ...(dockerScan.unavailableReason
      ? { dockerUnavailableReason: dockerScan.unavailableReason }
      : {})
  }
}

async function composeService(
  port: WorkspacePort,
  container: DockerContainerService | undefined,
  ancestry: ProcessAncestryTable,
  worktrees: WorkspacePortProbe[]
): Promise<WorkspaceService> {
  // A container's working dir is the compose file's directory, which is the
  // equivalent of a process cwd for attribution purposes.
  const workingDir = container?.composeWorkingDir ?? port.cwd ?? null
  const identity = await resolveServiceIdentity(workingDir ?? undefined)
  const origin = port.pid
    ? resolveServiceLaunchOrigin(port.pid, ancestry)
    : { launchCommand: null, launchedByAgent: null }

  return {
    id: port.id,
    kind: container ? 'container' : 'process',
    port: port.port,
    address: `${port.connectHost}:${port.port}`,
    serviceName: container ? container.image : identity.serviceName,
    launchCommand: container ? null : origin.launchCommand,
    launchedByAgent: origin.launchedByAgent,
    projectName: identity.projectName ?? container?.composeProject ?? null,
    projectRoot: identity.projectRoot,
    workingDir,
    pid: port.pid ?? null,
    processName: port.processName ?? null,
    owner: await resolveOwner(port, workingDir, worktrees),
    isOrphan: await isOrphanedWorkingDir(workingDir),
    container: container ? toContainerSummary(container) : null
  }
}

async function composeContainerOnlyService(
  port: number,
  container: DockerContainerService,
  worktrees: WorkspacePortProbe[]
): Promise<WorkspaceService> {
  const workingDir = container.composeWorkingDir
  const identity = await resolveServiceIdentity(workingDir ?? undefined)

  return {
    id: `container:${container.containerId}:${port}`,
    kind: 'container',
    port,
    address: `localhost:${port}`,
    serviceName: container.image,
    launchCommand: null,
    launchedByAgent: null,
    projectName: identity.projectName ?? container.composeProject,
    projectRoot: identity.projectRoot,
    workingDir,
    pid: null,
    processName: null,
    owner: workingDir ? (attributePortToWorkspace({ cwd: workingDir }, worktrees) ?? null) : null,
    isOrphan: await isOrphanedWorkingDir(workingDir),
    container: toContainerSummary(container)
  }
}

function toContainerSummary(container: DockerContainerService): WorkspaceService['container'] {
  return {
    containerId: container.containerId,
    containerName: container.containerName,
    image: container.image,
    composeProject: container.composeProject,
    state: container.state
  }
}

/**
 * Prefer the attribution the port scan already made. Fall back to the docker
 * working dir, which the port scan never sees because the listener is the
 * docker proxy rather than the container's own process.
 */
async function resolveOwner(
  port: WorkspacePort,
  workingDir: string | null,
  worktrees: WorkspacePortProbe[]
): Promise<WorkspaceService['owner']> {
  if (port.kind === 'workspace') {
    return port.owner
  }
  if (!workingDir) {
    return null
  }
  return attributePortToWorkspace({ cwd: workingDir }, worktrees) ?? null
}

/**
 * A recorded working directory that no longer exists means the workspace was
 * deleted while the service kept running — the case nothing else surfaces.
 *
 * Only a genuinely missing path counts. A permission error means the directory
 * is there and unreadable, and badging that as "workspace deleted" would be
 * inventing a fact the filesystem never reported.
 */
async function isOrphanedWorkingDir(workingDir: string | null): Promise<boolean> {
  if (!workingDir) {
    return false
  }
  return isMissingDirectory(workingDir)
}

function compareServices(a: WorkspaceService, b: WorkspaceService): number {
  // Processes first: they are the ones a user starts and stops during a session.
  const kindRank = (service: WorkspaceService): number => (service.kind === 'process' ? 0 : 1)
  return kindRank(a) - kindRank(b) || a.port - b.port
}
