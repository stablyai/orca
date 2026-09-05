import type * as pty from 'node-pty'
import type { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { normalizeLocalCallerSessionId } from './local-pty-launch-helpers'

export type PtyShutdownOperation = {
  promise: Promise<void>
  immediate: boolean
  rootSignalled: boolean
  proc: pty.IPty
}

export type PendingLocalPtySpawn = {
  canceled: boolean
}

export type DataCallback = (payload: {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
}) => void

export type ExitCallback = (payload: {
  id: string
  code: number
  incarnationId?: string
  cause?: TerminalExitCause
}) => void

let ptyCounter = 0
export const ptyProcesses = new Map<string, pty.IPty>()
export const ptyIncarnations = new Map<string, string>()
// Why: agent sessions always sweep descendant trees; plain terminals preserve nohup children except on immediate win32 shutdown.
export const ptyAgentSessionIds = new Set<string>()
// Why: descendant capture is async, so reattach/duplicate shutdown must wait for the original owner, not return a dying PTY.
export const ptyShutdownOperations = new Map<string, PtyShutdownOperation>()
export const pendingLocalPtySpawns = new Map<string, Set<PendingLocalPtySpawn>>()
export const ptyShellName = new Map<string, string>()
export const ptyAgentForegroundContextPaths = new Map<string, string[]>()
// Why: remember the last recognized agent foreground so a degraded scan doesn't report the shell and look like an exit.
// `pid` anchors the identity to the row that proved it (null when ambiguous);
// `at` is the last confirmation, so unanchored job evidence -- only a superset -- cannot hold it forever.
export const ptyLastRecognizedForeground = new Map<
  string,
  { name: string; pid: number | null; at: number }
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
// Why: a wrapper spawn (macOS TCC login) reports its own status, never the
// shell's, so its exit numbers must not be read as the agent's (STA-4536).
export const ptyReportsChildExitStatus = new Map<string, boolean>()
export const ptyForceKillTimers = new Map<string, ReturnType<typeof setTimeout>>()

let loadGeneration = 0
export const ptyLoadGeneration = new Map<string, number>()

export const dataListeners = new Set<DataCallback>()
export const exitListeners = new Set<ExitCallback>()
export const startupIngressByPty = new Map<string, PtyStartupIngress>()

/**
 * Disposes native node-pty listeners registered for a PTY id.
 */
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

/**
 * Removes all local tracking state for a PTY id after teardown.
 */
export function clearPtyState(id: string): void {
  clearLocalPtyForceKillTimer(id)
  runPtyCleanup(id)
  disposePtyListeners(id)
  disposePtyExitListener(id)
  ptyProcesses.delete(id)
  ptyIncarnations.delete(id)
  ptyAgentSessionIds.delete(id)
  ptyShellName.delete(id)
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

/**
 * Allocates either a stable caller-provided PTY id or a new numeric id.
 */
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
