import type { WorkspacePortKillResult, WorkspacePortProbe } from '../../shared/workspace-ports'
import type { WorkspaceServiceStopRequest } from '../../shared/workspace-services'
import { resolveDockerBinary } from './docker-compose-services'
import { runBoundedCommand } from './port-scan-command-runner'
import { findLocalPtyIdByProcessId, writeToLocalPty } from '../providers/local-pty-provider'
import { buildAgentStopNotice, toTerminalInput } from './agent-service-stop-notice'
import { readProcessAncestryTable, resolveServiceLaunchOrigin } from './service-process-ancestry'
import { killWorkspacePort } from './workspace-port-ownership'

/** `docker stop` sends SIGTERM and waits out the container's grace period. */
const DOCKER_STOP_TIMEOUT_MS = 15_000

/**
 * Stop a service the panel is showing.
 *
 * Containers cannot go through the process path: the listener holding a
 * published port is the shared docker proxy, so one SIGTERM would take down
 * every container's networking rather than the one the user asked for.
 */
export async function stopWorkspaceService(
  worktrees: readonly WorkspacePortProbe[],
  request: WorkspaceServiceStopRequest,
  runCommand: typeof runBoundedCommand = runBoundedCommand
): Promise<WorkspacePortKillResult> {
  if (request.kind === 'container') {
    return stopContainer(request.containerId, runCommand)
  }
  if (!Number.isSafeInteger(request.pid) || !Number.isSafeInteger(request.port)) {
    return { ok: false, reason: 'Invalid process or port.' }
  }
  // Capture the chain before the kill: once the process exits, its ancestors
  // are no longer reachable from it and the owning agent cannot be found.
  const notifyTarget = request.notifyAgent ? await resolveAgentPtyId(request.pid) : null
  const result = await killWorkspacePort(worktrees, {
    ...(request.repoId ? { repoId: request.repoId } : {}),
    pid: request.pid,
    port: request.port
  })
  if (result.ok && notifyTarget) {
    notifyAgentOfStop(notifyTarget, request)
  }
  return result
}

async function resolveAgentPtyId(pid: number): Promise<string | null> {
  const table = await readProcessAncestryTable()
  const origin = resolveServiceLaunchOrigin(pid, table)
  if (!origin.launchedByAgent) {
    return null
  }
  return findLocalPtyIdByProcessId(new Set(origin.ancestorPids))
}

function notifyAgentOfStop(
  ptyId: string,
  request: Extract<WorkspaceServiceStopRequest, { kind: 'process' }>
): void {
  const notice = buildAgentStopNotice({
    serviceName: request.serviceName ?? null,
    port: request.port,
    projectName: request.projectName ?? null
  })
  try {
    // Why fire-and-forget: the service is already stopped. A terminal that
    // closed between the kill and the write must not turn a successful stop
    // into a reported failure.
    writeToLocalPty(ptyId, toTerminalInput(notice))
  } catch {
    /* the agent's terminal is gone; nothing to tell */
  }
}

async function stopContainer(
  containerId: string,
  runCommand: typeof runBoundedCommand
): Promise<WorkspacePortKillResult> {
  // Why the shape check: this id crosses an IPC boundary and reaches a command
  // line. Docker ids are hex, so anything else is rejected rather than escaped.
  if (!/^[0-9a-f]{12,64}$/i.test(containerId)) {
    return { ok: false, reason: 'Invalid container id.' }
  }
  try {
    const binary = await resolveDockerBinary()
    await runCommand(binary, ['stop', containerId], DOCKER_STOP_TIMEOUT_MS)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT')) {
      return { ok: false, reason: 'Docker is not installed.' }
    }
    if (message.includes('timed out')) {
      return { ok: false, reason: 'Docker did not respond.' }
    }
    return { ok: false, reason: 'Failed to stop the container.' }
  }
}
