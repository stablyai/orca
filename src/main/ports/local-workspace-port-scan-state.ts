import type { WorkspacePortScanResult, WorkspacePortProbe } from '../../shared/workspace-ports'
import { isPortScanWorkerUnavailableError } from './port-scan-command-client'
import { PortScanCommandTimeoutError } from './port-scan-command-protocol'
import {
  WorkspacePortScanTimeoutBackoff,
  type WorkspacePortScanTimeoutBackoffSnapshot
} from './workspace-port-scan-timeout-backoff'

const SLOW_SPAWN_SKIP_METADATA_MS = 2_000
const commandTimeoutBackoff = new WorkspacePortScanTimeoutBackoff()
let loggedWorkerUnavailable = false
let skippedMetadataOnLastScan = false
let lastListenerMetadata = new Map<string, ProcessMetadata>()

export type WorkspacePortScanOptions = {
  requireMetadata?: boolean
}

export type RawListeningPort = {
  host: string
  port: number
  pid?: number
  processName?: string
  commandLine?: string
  cwd?: string
}

export type ProcessMetadata = {
  processName?: string
  commandLine?: string
  cwd?: string
}

export type NormalizedWorkspacePortProbe = {
  worktree: WorkspacePortProbe
  normalizedPath: string
}

export type PlatformListeningPortScan = {
  ports: RawListeningPort[]
  metadataAvailable: boolean
}

export function getWorkspacePortScanCooldown(): WorkspacePortScanTimeoutBackoffSnapshot {
  return commandTimeoutBackoff.snapshot()
}

export function recordWorkspacePortScanSuccess(): void {
  commandTimeoutBackoff.recordSuccess()
}

export function recordWorkspacePortScanTimeout(): void {
  commandTimeoutBackoff.recordTimeout()
}

export function resetWorkspacePortScanTimeoutBackoffForTests(): void {
  commandTimeoutBackoff.reset()
  loggedWorkerUnavailable = false
  skippedMetadataOnLastScan = false
  lastListenerMetadata = new Map()
}

export function shouldSkipMetadataCommands(
  spawnMs: number,
  options: WorkspacePortScanOptions
): boolean {
  if (options.requireMetadata) {
    return false
  }
  const skip = spawnMs > SLOW_SPAWN_SKIP_METADATA_MS && !skippedMetadataOnLastScan
  skippedMetadataOnLastScan = skip
  return skip
}

function listenerMetadataKey(port: RawListeningPort): string {
  return `${port.pid ?? 'unknown'}:${port.host}:${port.port}`
}

export function rememberListenerMetadata(ports: readonly RawListeningPort[]): void {
  lastListenerMetadata = new Map(
    ports.map((port) => [
      listenerMetadataKey(port),
      { processName: port.processName, commandLine: port.commandLine, cwd: port.cwd }
    ])
  )
}

export function recallListenerMetadata(port: RawListeningPort): RawListeningPort {
  const remembered = lastListenerMetadata.get(listenerMetadataKey(port))
  if (!remembered) {
    return port
  }
  return {
    ...port,
    processName: port.processName ?? remembered.processName,
    commandLine: port.commandLine ?? remembered.commandLine,
    cwd: port.cwd ?? remembered.cwd
  }
}

export function warnWorkspacePortScanFailure(error: unknown): void {
  if (isPortScanWorkerUnavailableError(error)) {
    if (loggedWorkerUnavailable) {
      return
    }
    loggedWorkerUnavailable = true
  }
  console.warn('[workspace-ports] scan failed', error)
}

export function isWorkspacePortScanCommandTimeout(error: unknown): boolean {
  return error instanceof PortScanCommandTimeoutError
}

export function makeUnavailableWorkspacePortScan(reason: string): WorkspacePortScanResult {
  return {
    platform: process.platform,
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}
