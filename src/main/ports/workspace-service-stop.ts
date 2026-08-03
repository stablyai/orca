import type { WorkspacePortKillResult, WorkspacePortProbe } from '../../shared/workspace-ports'
import type { WorkspaceServiceStopRequest } from '../../shared/workspace-services'
import { resolveDockerBinary } from './docker-compose-services'
import { runBoundedCommand } from './port-scan-command-runner'
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
  return killWorkspacePort(worktrees, {
    ...(request.repoId ? { repoId: request.repoId } : {}),
    pid: request.pid,
    port: request.port
  })
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
