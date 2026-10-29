import type { ClaudePeerIdentityReader } from '../claude/claude-peer-identity'
import type * as pty from 'node-pty'
import type { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { IPtyProvider } from './pty-provider-contract'
import type { PtyDataEvent } from './pty-provider-events'
import { getSpawnedShellName, normalizeLocalCallerSessionId } from './local-pty-launch-helpers'

export type PtyShutdownOperation = {
  promise: Promise<void>
  immediate: boolean
  rootSignalled: boolean
  proc: pty.IPty
}

export type PendingLocalPtySpawn = {
  cancellation: AbortController
}

export type DataCallback = (payload: PtyDataEvent) => void

export type ExitCallback = Parameters<IPtyProvider['onExit']>[0]

let ptyCounter = 0
export const ptyClaudePeerReaders = new Map<string, ClaudePeerIdentityReader>()
export const ptyProcesses = new Map<string, pty.IPty>()
export const ptyIncarnations = new Map<string, string>()
// Why: agent sessions always sweep descendant trees; plain terminals preserve nohup children except on immediate win32 shutdown.
export const ptyAgentSessionIds = new Set<string>()
// Why: descendant capture is async, so reattach/duplicate shutdown must wait for the original owner, not return a dying PTY.
export const ptyShutdownOperations = new Map<string, PtyShutdownOperation>()
export const pendingLocalPtySpawns = new Map<string, Set<PendingLocalPtySpawn>>()
// Why the full path: the shell proof must tell Git Bash's `bin\bash.exe` launcher from `usr\bin\bash.exe`.
export const ptyShellPath = new Map<string, string>()
export const ptyAgentForegroundContextPaths = new Map<string, string[]>()
// Preserve recognized identity across degraded scans; pid anchors it and at bounds unanchored job evidence.
// POSIX steady stores the proven pane fingerprint and node-pty name for cheap revalidation.
export const ptyLastRecognizedForeground = new Map<
  string,
  {
    name: string
    pid: number | null
    at: number
    steady?: { fingerprint: string; fallbackProcess: string | null } | null
  }
>()
export const ptyTerminalHandle = new Map<string, string>()
export const ptyWorktreeId = new Map<string, string>()
export const ptyInitialCwd = new Map<string, string>()
// Why: reattach carries current settings, not the live process's launch context; keep the first creator's WSL/native identity.
export const ptyWslDistroById = new Map<string, string | null>()
// Why: node-pty callbacks dispose before env teardown, but onExit separately owns physical-exit proof during termination.
export const ptyDisposables = new Map<string, { dispose: () => void }[]>()
export const ptyExitDisposables = new Map<string, { dispose: () => void }>()
export const ptyCleanupCallbacks = new Map<string, () => void>()
export const ptyTerminationMode = new Map<string, 'graceful' | 'force'>()
export const ptyPhysicalExits = new Map<string, PhysicalExitTracker>()
// macOS TCC wrapper status is not the shell/agent exit status (STA-4536).
export const ptyReportsChildExitStatus = new Map<string, boolean>()
export const ptyForceKillTimers = new Map<string, ReturnType<typeof setTimeout>>()

let loadGeneration = 0
export const ptyLoadGeneration = new Map<string, number>()

export const dataListeners = new Set<DataCallback>()
export const exitListeners = new Set<ExitCallback>()
export const startupIngressByPty = new Map<string, PtyStartupIngress>()

export function disposePtyListeners(id: string): void {
  const disposables = ptyDisposables.get(id)
  if (disposables) {
    for (const d of disposables) {
      d.dispose()
    }
    ptyDisposables.delete(id)
  }
}

export function disposePtyExitListener(id: string): void {
  ptyExitDisposables.get(id)?.dispose()
  ptyExitDisposables.delete(id)
}

export function clearLocalPtyForceKillTimer(id: string): void {
  const timer = ptyForceKillTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    ptyForceKillTimers.delete(id)
  }
}

export function runPtyCleanup(id: string): void {
  const cleanup = ptyCleanupCallbacks.get(id)
  if (!cleanup) {
    return
  }
  ptyCleanupCallbacks.delete(id)
  cleanup()
}

export function getPtyShellName(id: string): string | undefined {
  const shellPath = ptyShellPath.get(id)
  return shellPath === undefined ? undefined : getSpawnedShellName(shellPath)
}

export function clearPtyState(id: string): void {
  clearLocalPtyForceKillTimer(id)
  runPtyCleanup(id)
  disposePtyListeners(id)
  disposePtyExitListener(id)
  ptyProcesses.delete(id)
  ptyIncarnations.delete(id)
  ptyAgentSessionIds.delete(id)
  ptyShellPath.delete(id)
  ptyClaudePeerReaders.delete(id)
  ptyAgentForegroundContextPaths.delete(id)
  ptyLastRecognizedForeground.delete(id)
  ptyTerminalHandle.delete(id)
  ptyWorktreeId.delete(id)
  ptyInitialCwd.delete(id)
  ptyWslDistroById.delete(id)
  ptyLoadGeneration.delete(id)
  ptyTerminationMode.delete(id)
  ptyReportsChildExitStatus.delete(id)
  ptyPhysicalExits.delete(id)
}

export function allocatePtyId(sessionId: string | undefined): string {
  const requested = normalizeLocalCallerSessionId(sessionId)
  if (requested) {
    return requested
  }
  let id: string
  do {
    id = String(++ptyCounter)
  } while (ptyProcesses.has(id))
  return id
}

export function getLoadGeneration(): number {
  return loadGeneration
}

export function advanceLoadGeneration(): number {
  return ++loadGeneration
}

export function resetLoadGeneration(): void {
  loadGeneration = 0
}
