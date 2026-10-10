import {
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { DetectedPort } from '../../shared/ssh-types'
import type {
  WorkspacePort,
  WorkspacePortHostKillRequest,
  WorkspacePortHostScanResult,
  WorkspacePortKillResult,
  WorkspacePortProbe
} from '../../shared/workspace-ports'
import type { SshMultiplexerRequestOptions } from '../ssh/ssh-channel-multiplexer'
import { connectHostForBindHost } from './local-workspace-port-address'
import { killWorkspacePort, scanWorkspacePortProbes } from './workspace-port-ownership'

// Why: the relay walks /proc/*/fd on demand; a slow host must answer "unavailable", not hang the RPC.
const SSH_PORT_SCAN_TIMEOUT_MS = 10_000

type SshPortScanMultiplexer = {
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: SshMultiplexerRequestOptions
  ) => Promise<unknown>
}

export type WorkspacePortExecutionHostDeps = {
  /** Workspaces this host runs itself; the only processes Stop may signal here. */
  getLocalProbes: () => Promise<WorkspacePortProbe[]>
  /** Undefined means "not connected", never "the host's processes exited". */
  getSshMultiplexer: (targetId: string) => SshPortScanMultiplexer | undefined
}

function unavailable(executionHostId: string, reason: string): WorkspacePortHostScanResult {
  return {
    executionHostId,
    platform: 'unknown',
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDetectedPort(value: unknown): value is DetectedPort {
  if (!value || typeof value !== 'object') {
    return false
  }
  const port: { port?: unknown; host?: unknown; pid?: unknown; processName?: unknown } = value
  return (
    typeof port.port === 'number' &&
    Number.isSafeInteger(port.port) &&
    typeof port.host === 'string' &&
    (port.pid === undefined || typeof port.pid === 'number') &&
    (port.processName === undefined || typeof port.processName === 'string')
  )
}

// Why `external`: the relay reports listeners without workspace attribution, so no row it returns
// can be treated as workspace-owned (which is what makes a row stoppable).
function toUnattributedPort(port: DetectedPort): WorkspacePort {
  return {
    id: `${port.host}:${port.port}:${port.pid ?? 'unknown'}`,
    kind: 'external',
    bindHost: port.host,
    connectHost: connectHostForBindHost(port.host),
    port: port.port,
    ...(port.pid !== undefined ? { pid: port.pid } : {}),
    ...(port.processName !== undefined ? { processName: port.processName } : {}),
    protocol: 'unknown'
  }
}

async function scanSshExecutionHost(
  executionHostId: string,
  targetId: string,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortHostScanResult> {
  let response: unknown
  try {
    const mux = deps.getSshMultiplexer(targetId)
    if (!mux) {
      return unavailable(executionHostId, 'The SSH host is not connected.')
    }
    response = await mux.request('ports.detect', undefined, {
      timeoutMs: SSH_PORT_SCAN_TIMEOUT_MS
    })
  } catch (error) {
    return unavailable(executionHostId, `Could not scan the SSH host: ${errorMessage(error)}`)
  }
  const result: { ports?: unknown; platform?: unknown } =
    response && typeof response === 'object' ? response : {}
  if (!Array.isArray(result.ports) || !result.ports.every(isDetectedPort)) {
    return unavailable(executionHostId, 'The SSH host returned an invalid port scan.')
  }
  // Why: the relay answers an empty list on platforms it cannot scan; that is "could not look".
  if (result.platform !== 'linux' && result.platform !== 'win32') {
    return unavailable(executionHostId, 'Port detection is not supported on this SSH host.')
  }
  return {
    executionHostId,
    platform: result.platform,
    scannedAt: Date.now(),
    ports: result.ports.map(toUnattributedPort)
  }
}

/** Scans the execution host a workspace resolved to on this endpoint, and names it on the result. */
export async function scanWorkspacePortsOnExecutionHost(
  executionHostId: ExecutionHostId,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortHostScanResult> {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'local') {
    return { ...(await scanWorkspacePortProbes(await deps.getLocalProbes())), executionHostId }
  }
  if (host?.kind === 'ssh') {
    return scanSshExecutionHost(executionHostId, host.targetId, deps)
  }
  return unavailable(executionHostId, 'This workspace does not run on this server.')
}

/**
 * Stops a listener only on the host the workspace resolves to now, and only when that is also the
 * host the row was scanned on, so a row from one machine can never signal a same-numbered pid on
 * another.
 */
export async function killWorkspacePortOnExecutionHost(
  resolvedHostId: ExecutionHostId,
  request: Omit<WorkspacePortHostKillRequest, 'worktree'>,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortKillResult> {
  if (normalizeExecutionHostId(request.executionHostId) !== resolvedHostId) {
    return {
      ok: false,
      reason: 'This port was found on a different host than the workspace runs on. Rescan first.'
    }
  }
  const host = parseExecutionHostId(resolvedHostId)
  if (host?.kind === 'local') {
    return killWorkspacePort(await deps.getLocalProbes(), { pid: request.pid, port: request.port })
  }
  // Why: the relay can neither attribute a listener to a workspace nor signal it, so ownership
  // cannot be proven on the SSH host; refusing keeps Stop from ever acting on the wrong machine.
  if (host?.kind === 'ssh') {
    return { ok: false, reason: 'Stopping processes on an SSH host is not supported yet.' }
  }
  return { ok: false, reason: 'This workspace does not run on this server.' }
}
