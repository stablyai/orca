/* eslint-disable max-lines -- Why: PTY IPC is intentionally centralized in one
main-process module so spawn-time environment scoping, lifecycle cleanup,
foreground-process inspection, and renderer IPC stay behind a single audited
boundary. Splitting it by line count would scatter tightly coupled terminal
process behavior across files without a cleaner ownership seam. */
import { join, delimiter } from 'node:path'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import {
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
  ipcMain,
  app,
  powerMonitor
} from 'electron'
export { getBashShellReadyRcfileContent } from '../providers/local-pty-shell-ready'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { GlobalSettings, TuiAgent } from '../../shared/types'
import { terminalOutputBacklogCapChars } from '../../shared/terminal-scrollback-policy'
import type {
  PtyDeliveryWriteOff,
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../shared/pty-renderer-delivery-health'
import { extractHiddenStartupRendererQueryData } from '../../shared/terminal-reply-query-extraction'
import {
  type PtyMainDeliveryDiagnostics,
  type PtyPerPtyDeliveryDiagnostics,
  EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
  createPtyDeliveryBreadcrumbRing,
  redactPtyIdForDiagnostics
} from '../../shared/pty-delivery-diagnostics'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import {
  isWslShellName,
  resolveLocalWindowsTerminalRuntimeOptions
} from '../../shared/local-windows-terminal-runtime'
import { openCodeHookService } from '../opencode/hook-service'
import { mimoCodeHookService } from '../mimo/hook-service'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import { agentHookServer } from '../agent-hooks/server'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { piTitlebarExtensionService } from '../pi/titlebar-extension-service'
import { detectPiAgentKindFromCommand, type PiAgentKind } from '../../shared/pi-agent-kind'
import { isPwshAvailable } from '../pwsh'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import {
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyIdentityMismatchError,
  isSshPtyNotFoundError
} from '../providers/ssh-pty-provider'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { createPtySpawnTiming } from './pty-spawn-timing'
import { mintPtySessionId, isSafePtySessionId } from '../daemon/pty-session-id'
import { addNodePtyRecoveryHint } from '../daemon/node-pty-error-hints'
import { recordDaemonStreamBacklogEvent } from '../daemon/daemon-stream-backlog-probe'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import { CLAUDE_AUTH_ENV_VARS, hasClaudeAuthEnvConflict } from '../claude-accounts/environment'
import {
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned
} from '../claude-accounts/live-pty-gate'
import {
  applyTerminalAttributionEnv,
  resolveAttributionShellFamily
} from '../attribution/terminal-attribution'
import { ensureLinuxTerminalOrcaCliShimDir } from '../cli/linux-terminal-orca-cli-shim'
import { registerPty, unregisterPty } from '../memory/pty-registry'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { track } from '../telemetry/client'
import { classifyError } from '../telemetry/classify-error'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../shared/telemetry-events'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../shared/terminal-input'
import { isRemoteAgentHooksEnabled } from '../../shared/agent-hook-relay'
import { createTerminalSessionStateSaveFailureMessage } from '../../shared/terminal-session-state-save-failure'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import {
  resolveTerminalStartupCwdForWorkspace,
  type TerminalStartupCwdMissingDirFallback
} from '../../shared/terminal-startup-cwd'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  clearMigrationUnsupportedPty,
  clearMigrationUnsupportedPtysForPaneKey
} from '../agent-hooks/migration-unsupported-pty-state'
import { parseWslPath } from '../wsl'
import { mergePersistedWindowsPath } from '../pty/windows-environment-path'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { PtyProducerFlowController } from './pty-producer-flow-control'
import {
  clearHiddenRendererPtyDeliveryState,
  getHiddenRendererPtyDeliveryDebug,
  getHiddenRendererPtyIds,
  isHiddenPtyDeliveryGateEnabled,
  isHiddenRendererPty,
  markHiddenRendererPty,
  recordHiddenRendererPtyDataDrop,
  resetHiddenRendererPtyDeliveryDebugCounters,
  resetRendererScopedHiddenPtyDeliveryState,
  setRendererPtyDeliveryInterest,
  shouldDropHiddenRendererPtyData,
  unmarkHiddenRendererPty
} from './pty-hidden-delivery-gate'
import {
  clearNativeWindowsConptyPty,
  isNativeWindowsLocalPtySpawn,
  markNativeWindowsConptyPty
} from '../runtime/terminal-model-query-authority'
import { setTerminalViewAttributes } from '../runtime/terminal-view-attribute-store'
import { validateTerminalViewAttributes } from '../../shared/terminal-view-attributes'
import type { PtyModelRestoreReason } from '../../shared/pty-model-restore-marker'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { resolveSetupAgentSequenceLaunchCommand } from '../../shared/setup-agent-sequencing'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  answerStartupTerminalColorQueries,
  clearStartupTerminalColorQueryReplies,
  getStartupTerminalColorQueryReplyColors,
  moveStartupTerminalColorQueryReplies,
  registerStartupTerminalColorQueryReplies
} from './terminal-startup-color-query-replies'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus
} from '../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId. null = local provider.
// SSH providers will be registered here in Phase 1.

let localProvider: IPtyProvider = new LocalPtyProvider()
type FreshLocalFallbackProvider = IPtyProvider & {
  routesFreshSpawnsToLocalProvider?: true
}
const sshProviders = new Map<string, IPtyProvider>()
const SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS = 30_000
// Why: producer flow control changes terminal physics — a flooding shell now
// blocks on write instead of buffering in main. Kill switch: flip this one
// line to disable pause/resume entirely without untangling the wiring.
const PRODUCER_FLOW_CONTROL_ENABLED = true
// Why: PTY IDs are assigned at spawn time with a connectionId, but subsequent
// write/resize/kill calls only carry the PTY ID. This map lets us route
// post-spawn operations to the correct provider without the renderer needing
// to track connectionId per-PTY.
const ptyOwnership = new Map<string, string | null>()
// Why: mobile clients must mirror desktop PTY geometry even when the renderer
// cannot provide an xterm snapshot yet, such as immediately after tab creation.
const ptySizes = new Map<string, { cols: number; rows: number }>()
// Why: PTY data batching is window-bound, but the "recent user input" signal
// is PTY-scoped and must be cleared by every teardown path, including SSH and
// daemon shutdowns that do not flow through the local provider exit listener.
const lastInputAtByPty = new Map<string, number>()
const interactiveOutputCharsByPty = new Map<string, number>()
const activeRendererPtys = new Set<string>()
const visibleRendererPtys = new Set<string>()
const rendererVisibilityKnownPtys = new Set<string>()
const pendingHiddenRendererResizeOutputPtys = new Set<string>()
const deliveredHiddenRendererResizeOutputPtys = new Set<string>()
const KEEP_HISTORY_STOP_SETTLE_MS = 1_000
const KEEP_HISTORY_STOP_POLL_MS = 100
// Why: the agent-hooks server caches per-paneKey state (last prompt, last
// tool) that otherwise grows unbounded as panes come and go. Track the
// spawn-time paneKey so clearProviderPtyState can clear that cache on PTY
// teardown — the renderer knows the paneKey but the PTY lifecycle does not
// without this mapping.
const ptyPaneKey = new Map<string, string>()
// Why: reverse of ptyPaneKey — callers that receive a paneKey from outside the
// PTY lifecycle (e.g. the agent-hook server routing a cursor-agent status event
// back into the pane's data stream) need to find the ptyId for that paneKey.
// Kept in lock-step with ptyPaneKey via the same spawn and teardown sites.
const paneKeyPtyId = new Map<string, string>()

const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_ENDPOINT',
  // Why: PR 2778 briefly exported this scoped Claude settings path. Keep
  // deleting stale inherited values so older PTYs cannot leak the reverted path.
  'ORCA_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

export function getPtyIdForPaneKey(paneKey: string): string | undefined {
  return paneKeyPtyId.get(paneKey)
}

// Why: consumers (currently the cursor-agent synthesized-spinner loop in
// main/index.ts) need to tear down paneKey-scoped state when a PTY exits so
// intervals / timers cannot leak for the process lifetime. A callback
// registry keeps the cross-module dependency narrow — clearProviderPtyState
// only has to know about "things to notify", not about every consumer's
// internals.
type PaneKeyTeardownListener = (paneKey: string) => void
const paneKeyTeardownListeners = new Set<PaneKeyTeardownListener>()

export function registerPaneKeyTeardownListener(listener: PaneKeyTeardownListener): () => void {
  paneKeyTeardownListeners.add(listener)
  return () => paneKeyTeardownListeners.delete(listener)
}

// Why: pre-signal handshake — the renderer declares it will own the serializer
// for a paneKey BEFORE issuing pty:spawn. The cooperation gate at provider.spawn
// return consults this map to suppress the daemon-snapshot seed when a renderer
// is taking over. Generation tokens prevent paneKey-reuse races during teardown:
// a paneKeyTeardownListener cleanup only fires settle when the captured gen
// still matches, so a remount that pre-signals before the old PTY's teardown
// runs is preserved. See docs/mobile-prefer-renderer-scrollback.md.
let pendingSerializerGenSeq = 0
const pendingByPaneKey = new Map<string, { gen: number; ownerWebContentsId: number | null }>()
const pendingPaneSerializerCleanupRegistered = new Set<number>()
type PaneSpawnReservation = {
  promise: Promise<PaneSpawnReservationResult>
  resolve: (result: PaneSpawnReservationResult) => void
  reject: (error: unknown) => void
}
type PaneSpawnReservationResult = {
  id: string
  launchConfig?: SleepingAgentLaunchConfig
} & Partial<PtySpawnResult>
// Why: mobile runtime materialization and a newly-focused renderer pane can
// race to spawn the same tab/leaf. Key by stable paneKey so the loser adopts
// the winner's PTY instead of creating a duplicate shell.
const paneSpawnReservationsByPaneKey = new Map<string, PaneSpawnReservation>()
// Why: at PTY spawn time we capture the gen that was pending for the spawn's
// paneKey, so teardown can settle ONLY that gen. Without this, a paneKey
// remount that replaces the pending entry with a new gen would still get
// stomped by the old PTY's teardown firing settle on the wrong gen.
const ptyPendingGenByPtyId = new Map<string, number>()
// Why: the runtime's hasRendererSerializer probe needs a ptyId-keyed signal.
// Populated on settlePaneSerializer (renderer has registered for this ptyId)
// and cleared on PTY teardown.
const rendererSerializerByPtyId = new Set<string>()

function parseValidPaneKey(paneKey: unknown): ReturnType<typeof parsePaneKey> {
  if (typeof paneKey !== 'string' || paneKey.length > 256) {
    return null
  }
  return parsePaneKey(paneKey)
}

function isValidPaneKey(paneKey: unknown): paneKey is string {
  return parseValidPaneKey(paneKey) !== null
}

function shouldRefreshNativeClaudeAgentTeamsEnv(args: {
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  const capturedCommand = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  const capturedArgs = args.launchConfig?.agentArgs?.trim() ?? ''
  const capturedLaunch = `${capturedCommand} ${capturedArgs}`.trim()
  return /(^|\s)--teammate-mode(?:=|\s+)auto(?:\s|$)/.test(capturedLaunch)
}

function rememberPaneKeyForPty(ptyId: string, paneKey: unknown): string | null {
  const normalizedPaneKey = typeof paneKey === 'string' ? paneKey.trim() : ''
  if (!isValidPaneKey(normalizedPaneKey)) {
    return null
  }
  ptyPaneKey.set(ptyId, normalizedPaneKey)
  paneKeyPtyId.set(normalizedPaneKey, ptyId)
  return normalizedPaneKey
}

function cleanupPendingPaneSerializersForSender(ownerWebContentsId: number): void {
  pendingPaneSerializerCleanupRegistered.delete(ownerWebContentsId)
  for (const [paneKey, pending] of pendingByPaneKey) {
    if (pending.ownerWebContentsId === ownerWebContentsId) {
      pendingByPaneKey.delete(paneKey)
    }
  }
}

function registerPendingPaneSerializerCleanup(sender: WebContents | undefined): void {
  if (!sender || pendingPaneSerializerCleanupRegistered.has(sender.id)) {
    return
  }
  pendingPaneSerializerCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => cleanupPendingPaneSerializersForSender(sender.id))
}

function declarePendingPaneSerializer(paneKey: string, sender: WebContents | undefined): number {
  const gen = ++pendingSerializerGenSeq
  registerPendingPaneSerializerCleanup(sender)
  pendingByPaneKey.set(paneKey, { gen, ownerWebContentsId: sender?.id ?? null })
  return gen
}

function reservePaneSpawn(paneKey: string): PaneSpawnReservation {
  let resolve!: (result: PaneSpawnReservationResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<PaneSpawnReservationResult>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  promise.catch(() => {})
  const reservation = { promise, resolve, reject }
  paneSpawnReservationsByPaneKey.set(paneKey, reservation)
  return reservation
}

function clearPaneSpawnReservation(paneKey: string, reservation: PaneSpawnReservation): void {
  if (paneSpawnReservationsByPaneKey.get(paneKey) === reservation) {
    paneSpawnReservationsByPaneKey.delete(paneKey)
  }
}

function rejectPaneSpawnReservation(
  paneKey: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  error: unknown
): void {
  if (!reservation) {
    return
  }
  reservation.reject(error)
  if (paneKey) {
    clearPaneSpawnReservation(paneKey, reservation)
  }
}

function resolvePaneSpawnReservation<T extends PaneSpawnReservationResult>(
  paneKey: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  response: T
): T {
  if (!reservation) {
    return response
  }
  reservation.resolve(response)
  if (paneKey) {
    clearPaneSpawnReservation(paneKey, reservation)
  }
  return response
}

function settlePendingPaneSerializer(paneKey: string, gen: number): void {
  if (pendingByPaneKey.get(paneKey)?.gen === gen) {
    pendingByPaneKey.delete(paneKey)
  }
}

export function hasPendingRendererSerializerForPaneKey(paneKey: string): boolean {
  return isValidPaneKey(paneKey) && pendingByPaneKey.has(paneKey)
}

function getProvider(connectionId: string | null | undefined): IPtyProvider {
  if (!connectionId) {
    return localProvider
  }
  const provider = sshProviders.get(connectionId)
  if (!provider) {
    throw new Error(`No PTY provider for connection "${connectionId}"`)
  }
  return provider
}

function getProviderForPty(ptyId: string): IPtyProvider {
  const connectionId = ptyOwnership.get(ptyId)
  if (connectionId === undefined) {
    return localProvider
  }
  return getProvider(connectionId)
}

function hasPtyProviderForInspection(ptyId: string): boolean {
  // Why: process inspection is background polling; disconnected SSH hosts should
  // read as idle instead of surfacing repeated IPC errors.
  const connectionId = ptyOwnership.get(ptyId)
  return connectionId == null || sshProviders.has(connectionId)
}

function getAppPtyId(connectionId: string | null | undefined, ptyId: string): string {
  return connectionId ? toAppSshPtyId(connectionId, ptyId) : ptyId
}

function getRelayPtyId(connectionId: string | null | undefined, ptyId: string): string {
  return connectionId ? toRelaySshPtyId(connectionId, ptyId) : ptyId
}

function stripRemotePaneEnvWhenHooksDisabled(
  connectionId: string | null | undefined,
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!connectionId || isRemoteAgentHooksEnabled()) {
    return env
  }
  if (
    !env ||
    (!('ORCA_PANE_KEY' in env) &&
      !('ORCA_TAB_ID' in env) &&
      !('ORCA_WORKTREE_ID' in env) &&
      !('ORCA_AGENT_LAUNCH_TOKEN' in env))
  ) {
    return env
  }
  const stripped = { ...env }
  delete stripped.ORCA_PANE_KEY
  delete stripped.ORCA_TAB_ID
  delete stripped.ORCA_WORKTREE_ID
  delete stripped.ORCA_AGENT_LAUNCH_TOKEN
  return stripped
}

function tryGetProviderForPty(ptyId: string): IPtyProvider | undefined {
  try {
    return getProviderForPty(ptyId)
  } catch {
    return undefined
  }
}

function getProviderForStartupTerminalColorReply(ptyId: string): IPtyProvider | undefined {
  const ownedConnectionId = ptyOwnership.get(ptyId)
  if (ownedConnectionId !== undefined) {
    return getProvider(ownedConnectionId)
  }
  const parsedSshId = parseAppSshPtyId(ptyId)
  if (parsedSshId) {
    return getProvider(parsedSshId.connectionId)
  }
  return localProvider
}

export function answerStartupTerminalColorQueriesForPty(ptyId: string, data: string): string {
  return answerStartupTerminalColorQueries(ptyId, data, getProviderForStartupTerminalColorReply)
}

function normalizeNodePtySpawnError(err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const hintedMessage = addNodePtyRecoveryHint(rawMessage)
  if (hintedMessage === rawMessage && err instanceof Error) {
    return err
  }
  if (err instanceof Error) {
    // Why: preserve the original stack/name/custom fields while returning the
    // same recovery guidance as the renderer-driven pty:spawn path.
    err.message = hintedMessage
    return err
  }
  return new Error(hintedMessage)
}

function isPtyAlreadyGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return isSshPtyNotFoundError(err) || /Session not found/i.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  })
}

async function isProviderPtyLive(provider: IPtyProvider, ptyId: string): Promise<boolean> {
  return (await provider.listProcesses()).some((session) => session.id === ptyId)
}

async function verifyPtyStopped(
  provider: IPtyProvider,
  ptyId: string,
  opts: { keepHistory?: boolean } | undefined
): Promise<boolean> {
  if (await isProviderPtyLive(provider, ptyId)) {
    return false
  }
  if (!opts?.keepHistory) {
    return true
  }
  const deadline = Date.now() + KEEP_HISTORY_STOP_SETTLE_MS
  while (Date.now() < deadline) {
    await delay(KEEP_HISTORY_STOP_POLL_MS)
    if (await isProviderPtyLive(provider, ptyId)) {
      return false
    }
  }
  return true
}

function finishPtyShutdown(
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined
): void {
  clearProviderPtyState(id)
  if (connectionId) {
    store?.markSshRemotePtyLease(connectionId, getRelayPtyId(connectionId, id), 'terminated')
  }
  ptyOwnership.delete(id)
  markClaudePtyExited(id)
}

// ─── Host PTY env assembly ──────────────────────────────────────────
// Why: both the LocalPtyProvider.buildSpawnEnv closure and the daemon-active
// fallback in pty:spawn need the same set of host-local env injections
// (OpenCode plugin dir, agent-hook server coordinates, Pi/OMP managed
// extensions, Codex account home, dev-mode CLI overrides, GitHub attribution
// shims). They used to be implemented twice, which silently drifted —
// daemon-backed PTYs never got the OpenCode plugin, Pi integration, Codex
// home, or dev CLI PATH prepend, so status dots, Pi state, Codex switching, and CLI→dev
// routing were all broken for daemon users (the common case).
//
// Centralizing the injections here makes future additions fail-safe: a new
// variable added to this function lands in BOTH spawn paths or NEITHER.

export type BuildPtyHostEnvOptions = {
  isPackaged: boolean
  userDataPath: string
  selectedCodexHomePath: string | null
  skipCodexHomeEnv?: boolean
  githubAttributionEnabled: boolean
  /** The launch command the renderer chose for this PTY (e.g. 'pi', 'omp',
   *  'claude'). Used to resolve the per-agent managed extension target for
   *  Pi / OMP - both consume `PI_CODING_AGENT_DIR` but default to different
   *  `~/.<kind>/agent` paths. Undefined for bare-shell spawns; defaults
   *  resolve to Pi for back-compat. NEVER infer from disk presence; that's
   *  the bug this option fixes (cross-agent shadowing when both dirs exist). */
  launchCommand?: string
  shellPath?: string
  isWsl?: boolean
  /** Distro for WSL spawns (null = Windows default distro). Drives the WSL
   *  hook relay ensure + guest endpoint repoint; only read when isWsl. */
  wslDistro?: string | null
  agentStatusHooksEnabled: boolean
  networkProxySettings?: NetworkProxySettings
}

function readInheritedPath(baseEnv: Record<string, string>): string {
  return baseEnv.PATH ?? baseEnv.Path ?? process.env.PATH ?? process.env.Path ?? ''
}

function firstPathEntry(pathValue: string | undefined): string | null {
  const first = pathValue?.split(delimiter).find((entry) => entry.trim().length > 0)
  return first ?? null
}

function promoteAgentTeamsShimPath(
  env: Record<string, string> | undefined,
  requestedPath: string | undefined
): void {
  if (!env?.ORCA_AGENT_TEAMS_TEAM_ID) {
    return
  }
  const shimPath = firstPathEntry(requestedPath)
  if (!shimPath) {
    return
  }
  const currentPathKey = env.PATH !== undefined || env.Path === undefined ? 'PATH' : 'Path'
  const currentPath = env[currentPathKey] ?? ''
  const remaining = currentPath
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== shimPath)
  // Why: host env injection can prepend Orca's attribution/dev shims. Claude
  // Agent Teams must still resolve our fake tmux before any real tmux.
  env[currentPathKey] = [shimPath, ...remaining].join(delimiter)
}

function deleteRequestedEnvKeys(
  env: Record<string, string> | undefined,
  keys: string[] | undefined
): void {
  if (!env || !keys) {
    return
  }
  for (const key of keys) {
    delete env[key]
  }
}

function shouldSkipCodexHomeEnvForWindowsShell(
  shellPath: string | undefined,
  cwd: string | undefined
): boolean {
  return isWslShellName(shellPath) || (typeof cwd === 'string' && parseWslPath(cwd) !== null)
}

const CODEX_HOME_ENV_KEYS = ['CODEX_HOME', 'ORCA_CODEX_HOME'] as const
type GetSelectedCodexHomePath = (target?: CodexAccountSelectionTarget) => string | null
type PrepareClaudeAuth = (
  target?: ClaudeAccountSelectionTarget
) => Promise<ClaudeRuntimeAuthPreparation>

function getCodexSelectionTargetForPty(
  shellPath: string | undefined,
  cwd: string | undefined,
  wslDistro?: string | null
): CodexAccountSelectionTarget {
  const wslPath = typeof cwd === 'string' ? parseWslPath(cwd) : null
  if (isWslShellName(shellPath) || wslPath) {
    return { runtime: 'wsl', wslDistro: wslPath?.distro ?? wslDistro ?? null }
  }
  return { runtime: 'host' }
}

function getCompatibleSelectedCodexHomePath(
  target: CodexAccountSelectionTarget,
  selectedCodexHomePath: string | null
): string | null {
  if (!selectedCodexHomePath) {
    return null
  }
  const wslInfo = parseWslPath(selectedCodexHomePath)
  if (target.runtime === 'wsl') {
    return wslInfo || !isHostCodexHomeForWsl(selectedCodexHomePath) ? selectedCodexHomePath : null
  }
  return wslInfo || (process.platform === 'win32' && isWslCodexHomeForHost(selectedCodexHomePath))
    ? null
    : selectedCodexHomePath
}

function readEnvWithProcessFallback(
  baseEnv: Record<string, string>,
  key: string
): string | undefined {
  return baseEnv[key] ?? process.env[key]
}

function resolvePiAgentSourceDir(
  baseEnv: Record<string, string>,
  kind: PiAgentKind
): string | undefined {
  const sourceKey = kind === 'omp' ? 'ORCA_OMP_SOURCE_AGENT_DIR' : 'ORCA_PI_SOURCE_AGENT_DIR'
  const overlayKey = kind === 'omp' ? 'ORCA_OMP_CODING_AGENT_DIR' : 'ORCA_PI_CODING_AGENT_DIR'
  const otherOverlayKey = kind === 'omp' ? 'ORCA_PI_CODING_AGENT_DIR' : 'ORCA_OMP_CODING_AGENT_DIR'

  const sourceDir = readEnvWithProcessFallback(baseEnv, sourceKey)
  if (sourceDir) {
    return sourceDir
  }

  const publicDir = readEnvWithProcessFallback(baseEnv, 'PI_CODING_AGENT_DIR')
  const ownOverlayDir = readEnvWithProcessFallback(baseEnv, overlayKey)
  const otherOverlayDir = readEnvWithProcessFallback(baseEnv, otherOverlayKey)
  // Why: if PI_CODING_AGENT_DIR is just a restored Orca overlay from either
  // kind and the matching source shadow is absent, remirroring it would leak
  // another agent's overlay tree into this launch. Fall through to defaults.
  if (publicDir && publicDir !== ownOverlayDir && publicDir !== otherOverlayDir) {
    return publicDir
  }

  return readShellStartupEnvVar(
    'PI_CODING_AGENT_DIR',
    baseEnv.HOME ?? process.env.HOME,
    baseEnv.SHELL ?? process.env.SHELL
  )
}

function resolveScopedPiAgentSourceDir(
  baseEnv: Record<string, string>,
  kind: PiAgentKind
): string | undefined {
  const sourceKey = kind === 'omp' ? 'ORCA_OMP_SOURCE_AGENT_DIR' : 'ORCA_PI_SOURCE_AGENT_DIR'
  return readEnvWithProcessFallback(baseEnv, sourceKey)
}

function clearPiAgentShadowEnv(baseEnv: Record<string, string>, kind: PiAgentKind): void {
  if (kind === 'omp') {
    delete baseEnv.ORCA_OMP_CODING_AGENT_DIR
    delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR
    delete baseEnv.ORCA_OMP_STATUS_EXTENSION
    return
  }
  delete baseEnv.ORCA_PI_CODING_AGENT_DIR
  delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR
}

function exposePiManagedExtensionEnv(
  baseEnv: Record<string, string>,
  kind: PiAgentKind,
  managedEnv: Record<string, string>
): void {
  if (kind === 'omp') {
    delete baseEnv.ORCA_OMP_CODING_AGENT_DIR
    if (managedEnv.ORCA_OMP_SOURCE_AGENT_DIR) {
      baseEnv.ORCA_OMP_SOURCE_AGENT_DIR = managedEnv.ORCA_OMP_SOURCE_AGENT_DIR
    } else {
      delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR
    }
    if (managedEnv.ORCA_OMP_STATUS_EXTENSION) {
      baseEnv.ORCA_OMP_STATUS_EXTENSION = managedEnv.ORCA_OMP_STATUS_EXTENSION
    } else {
      delete baseEnv.ORCA_OMP_STATUS_EXTENSION
    }
    return
  }
  delete baseEnv.ORCA_PI_CODING_AGENT_DIR
  if (managedEnv.ORCA_PI_SOURCE_AGENT_DIR) {
    baseEnv.ORCA_PI_SOURCE_AGENT_DIR = managedEnv.ORCA_PI_SOURCE_AGENT_DIR
  } else {
    delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR
  }
}

function mergePtyEnvDeletions(
  existingKeys: string[] | undefined,
  additionalKeys: readonly string[]
): string[] | undefined {
  if (!existingKeys && additionalKeys.length === 0) {
    return undefined
  }
  return Array.from(new Set([...(existingKeys ?? []), ...additionalKeys]))
}

function getInheritedAgentHookEnvKeysToDelete(
  spawnEnv: Record<string, string> | undefined
): string[] {
  const env = spawnEnv ?? {}
  // Why: daemon/local providers merge process.env after main-process cleanup.
  // Delete reverted or unavailable hook env keys there without dropping fresh
  // receiver coordinates that buildPtyHostEnv intentionally set.
  return AGENT_HOOK_RUNTIME_ENV_KEYS.filter((key) => env[key] === undefined)
}

// Why: when agent status is disabled, a nested Orca terminal can still pass
// through prior OpenCode or legacy Pi/OMP overlay env. Restore the user's
// original source dir when Orca recorded one, otherwise strip only values
// known to be ours.
function restoreOrStripOverlayEnv(
  baseEnv: Record<string, string>,
  keys: {
    primary: string
    overlay: string
    source: string
  }
): void {
  const sourceValue = baseEnv[keys.source] ?? process.env[keys.source]
  const overlayValue = baseEnv[keys.overlay] ?? process.env[keys.overlay]
  if (sourceValue) {
    baseEnv[keys.primary] = sourceValue
  } else if (overlayValue && baseEnv[keys.primary] === overlayValue) {
    delete baseEnv[keys.primary]
  }
  delete baseEnv[keys.overlay]
  delete baseEnv[keys.source]
}

function isMimoLaunchCommand(launchCommand: string | undefined): boolean {
  const binary = getCommandTokenPathBasename(getFirstCommandToken(launchCommand ?? ''))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
  return binary === 'mimo'
}

function resolveMimocodeSourceHome(baseEnv: Record<string, string>): string | undefined {
  const sourceHome = baseEnv.ORCA_MIMOCODE_SOURCE_HOME ?? process.env.ORCA_MIMOCODE_SOURCE_HOME
  if (sourceHome) {
    return sourceHome
  }
  const configHome = baseEnv.MIMOCODE_HOME ?? process.env.MIMOCODE_HOME
  const orcaHome = baseEnv.ORCA_MIMOCODE_HOME ?? process.env.ORCA_MIMOCODE_HOME
  if (configHome && orcaHome && configHome === orcaHome) {
    return undefined
  }
  return configHome
}

function resolveOpenCodeSourceConfigDir(baseEnv: Record<string, string>): string | undefined {
  const sourceDir =
    baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR ?? process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  if (sourceDir) {
    return sourceDir
  }

  const configDir = baseEnv.OPENCODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR
  const orcaConfigDir = baseEnv.ORCA_OPENCODE_CONFIG_DIR ?? process.env.ORCA_OPENCODE_CONFIG_DIR
  // Why: nested Orca terminals inherit OPENCODE_CONFIG_DIR from the parent
  // PTY. If there is no recorded source dir, that value is Orca-owned, not a
  // user config. Treating it as user config makes child Orcas mirror Orca's
  // hook dir and can create large OpenCode runtime trees per terminal.
  if (configDir && orcaConfigDir && configDir === orcaConfigDir) {
    return undefined
  }

  return (
    configDir ??
    readShellStartupEnvVar(
      'OPENCODE_CONFIG_DIR',
      baseEnv.HOME ?? process.env.HOME,
      baseEnv.SHELL ?? process.env.SHELL
    )
  )
}

/**
 * Mutates `baseEnv` in place with all host-local PTY env vars and returns it.
 *
 * This is the single source of truth for the env shape an Orca PTY needs
 * BEFORE the provider-specific wrapper (LocalPtyProvider's TERM/LANG defaults,
 * DaemonPtyAdapter's subprocess env). Callers are responsible for the SSH
 * guard — if `args.connectionId` is set, do NOT call this function, because
 * every injection here is either host-loopback (hook server, attribution
 * shims) or references paths on the local filesystem that would be meaningless
 * to a remote shell.
 */
export function buildPtyHostEnv(
  id: string,
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): Record<string, string> {
  mergePersistedWindowsPath(baseEnv)
  Object.assign(baseEnv, buildConfiguredProxyEnv(opts.networkProxySettings))

  // Why: the Local path passes a baseEnv that already includes process.env
  // (LocalPtyProvider.spawn merges it before calling buildSpawnEnv). The
  // daemon path passes only args.env since process.env propagates to the
  // daemon subprocess via fork inheritance, not the IPC wire. Checking both
  // sources when reading a potentially-user-provided value keeps the guards
  // in lock-step across spawn paths without pushing process.env onto the
  // IPC wire unnecessarily.
  const preexistingOpenCodeConfigDir = resolveOpenCodeSourceConfigDir(baseEnv)
  const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(baseEnv, opts.launchCommand)
  const piAgentKind = detectPiAgentKindFromCommand(launchCommandHint)
  const hasLaunchCommand =
    typeof launchCommandHint === 'string' && launchCommandHint.trim().length > 0
  const shouldPrepareOmpShadow = piAgentKind === 'omp' || !hasLaunchCommand
  // Why: source shadows are agent-scoped. Trusting the other kind's source
  // would reintroduce the exact Pi/OMP extension-state shadowing this PR fixes.
  const preexistingPiAgentDir = resolvePiAgentSourceDir(baseEnv, 'pi')
  const preexistingOmpAgentDir =
    piAgentKind === 'omp'
      ? resolvePiAgentSourceDir(baseEnv, 'omp')
      : resolveScopedPiAgentSourceDir(baseEnv, 'omp')

  if (opts.agentStatusHooksEnabled) {
    // Why: OPENCODE_CONFIG_DIR is a singular path, not a colon-list, so a user
    // value cannot coexist with an Orca-only injection. Hand the user's value
    // (when present) to the hook service and let it materialize a source-scoped
    // mirror overlay that lets the user's plugins and Orca's status plugin
    // load together. See docs/opencode-config-dir-collision.md.
    Object.assign(baseEnv, openCodeHookService.buildPtyEnv(id, preexistingOpenCodeConfigDir))
    if (baseEnv.OPENCODE_CONFIG_DIR) {
      // Why: ~/.zshrc can re-export the user's default after spawn; shell-ready
      // wrappers restore this PTY-scoped value after user startup files run.
      baseEnv.ORCA_OPENCODE_CONFIG_DIR = baseEnv.OPENCODE_CONFIG_DIR
      if (preexistingOpenCodeConfigDir) {
        // Why: terminals launched from another Orca terminal inherit the overlay
        // as OPENCODE_CONFIG_DIR; keep the original source so overlays do not
        // mirror overlays and drop the user's real config.
        baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR = preexistingOpenCodeConfigDir
      } else {
        delete baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR
      }
    }
    if (isMimoLaunchCommand(launchCommandHint)) {
      const preexistingMimocodeHome = resolveMimocodeSourceHome(baseEnv)
      Object.assign(baseEnv, mimoCodeHookService.buildPtyEnv(id, preexistingMimocodeHome))
      if (baseEnv.MIMOCODE_HOME) {
        baseEnv.ORCA_MIMOCODE_HOME = baseEnv.MIMOCODE_HOME
        if (preexistingMimocodeHome) {
          baseEnv.ORCA_MIMOCODE_SOURCE_HOME = preexistingMimocodeHome
        } else {
          delete baseEnv.ORCA_MIMOCODE_SOURCE_HOME
        }
      }
    }
  } else {
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
    })
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'MIMOCODE_HOME',
      overlay: 'ORCA_MIMOCODE_HOME',
      source: 'ORCA_MIMOCODE_SOURCE_HOME'
    })
  }

  // Why: Claude/Codex native hooks run inside the shell process, so Orca
  // must inject the loopback receiver coordinates before the agent starts.
  // Without these env vars the global hook config cannot map callbacks back
  // to the correct Orca pane.
  // Why: nested Orca terminals can inherit another process's hook endpoint or
  // token. Strip all hook runtime coordinates before injecting this PTY's fresh
  // server values so callbacks route to the owning app/runtime.
  for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
    delete baseEnv[key]
  }
  if (opts.agentStatusHooksEnabled) {
    Object.assign(baseEnv, agentHookServer.buildPtyEnv())
    if (opts.isWsl === true) {
      // Why: hook POSTs to 127.0.0.1 die inside WSL's NAT namespace. Ensure
      // the guest-resident relay for this distro (covers fresh spawns and
      // post-restart reattach re-spawns), and once the relay has reported the
      // guest home, point restart re-coordination at the relay-written
      // guest-side endpoint file instead of the /p-translated Windows one.
      const distro = opts.wslDistro ?? null
      wslHookRelayManager.ensureForDistro(distro)
      const guestEndpoint = wslHookRelayManager.getGuestEndpointFilePath(distro)
      if (guestEndpoint) {
        baseEnv.ORCA_AGENT_HOOK_ENDPOINT = guestEndpoint
      }
    }
  }

  // Why: PI_CODING_AGENT_DIR owns Pi's / OMP's full config/session root. Keep
  // that home as the user's normal source of truth and install only Orca-owned,
  // env-guarded extension files into the selected agent's extension dir.
  if (opts.agentStatusHooksEnabled) {
    clearPiAgentShadowEnv(baseEnv, 'pi')
    clearPiAgentShadowEnv(baseEnv, 'omp')
    if (piAgentKind === 'pi') {
      const piEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingPiAgentDir, 'pi')
      Object.assign(baseEnv, piEnv)
      exposePiManagedExtensionEnv(baseEnv, 'pi', piEnv)
    }

    if (shouldPrepareOmpShadow) {
      const ompEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingOmpAgentDir, 'omp')
      Object.assign(baseEnv, ompEnv)
      exposePiManagedExtensionEnv(baseEnv, 'omp', ompEnv)
    }
  } else {
    // Why: when agent status is disabled we must strip BOTH kinds' shadow vars
    // so a nested PTY does not inherit a stale overlay from either agent.
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'PI_CODING_AGENT_DIR',
      overlay: 'ORCA_PI_CODING_AGENT_DIR',
      source: 'ORCA_PI_SOURCE_AGENT_DIR'
    })
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'PI_CODING_AGENT_DIR',
      overlay: 'ORCA_OMP_CODING_AGENT_DIR',
      source: 'ORCA_OMP_SOURCE_AGENT_DIR'
    })
    delete baseEnv.ORCA_OMP_STATUS_EXTENSION
  }

  // Why: Codex account switching now materializes auth into an Orca-scoped
  // runtime home, and Codex launched inside Orca terminals must use that same
  // prepared home as quota fetches and other entry points. Keep the override
  // PTY-scoped so dev/prod Orcas do not share hooks through ~/.codex.
  if (opts.skipCodexHomeEnv) {
    delete baseEnv.CODEX_HOME
    delete baseEnv.ORCA_CODEX_HOME
  } else if (opts.selectedCodexHomePath) {
    baseEnv.CODEX_HOME = opts.selectedCodexHomePath
    // Why: user startup files may re-export CODEX_HOME; shell-ready wrappers
    // restore this runtime home before Codex can be launched from the prompt.
    baseEnv.ORCA_CODEX_HOME = opts.selectedCodexHomePath
  }

  // Why: WSL shells need the managed userData root for shell-ready wrappers; dev-mode terminals need the same export so `orca` targets the live dev instance.
  if (opts.isWsl) {
    baseEnv.ORCA_USER_DATA_PATH = opts.userDataPath
    // Why: managed WSL registration deliberately uses `orca-ide`; exposing
    // that literal keeps agent guidance scoped to WSL without a bare-orca shim.
    baseEnv.ORCA_CLI_COMMAND = opts.isPackaged ? 'orca-ide' : 'orca-dev'
  } else {
    if (!opts.isPackaged) {
      baseEnv.ORCA_USER_DATA_PATH ??= opts.userDataPath
    }
    delete baseEnv.ORCA_CLI_COMMAND
  }
  // Why: dev mode needs the launcher PATH override so `orca` resolves to the dev build instead of the production binary at /usr/local/bin/orca.
  if (!opts.isPackaged) {
    const devCliBin = join(opts.userDataPath, 'cli', 'bin')
    const inheritedPath = readInheritedPath(baseEnv)
    // Why: avoid a trailing delimiter when PATH is empty — some shells
    // treat an empty segment as `.`, which would let commands resolve from
    // the current working directory (a foot-gun we don't want to create
    // for dev terminals).
    baseEnv.PATH = inheritedPath ? `${devCliBin}${delimiter}${inheritedPath}` : devCliBin
  } else if (process.platform === 'linux') {
    // Why: the Linux CLI installs as `orca-ide` (never shadowing GNOME's
    // /usr/bin/orca screen reader), but agent-facing guidance invokes bare
    // `orca`. Scope a bare-`orca` shim to Orca-managed PTYs so agents reach
    // the Orca CLI instead of the screen reader (stablyai/orca#7904).
    const shimDir = ensureLinuxTerminalOrcaCliShimDir({ userDataPath: opts.userDataPath })
    if (shimDir) {
      const inheritedEntries = readInheritedPath(baseEnv)
        .split(delimiter)
        .filter((entry) => entry.length > 0 && entry !== shimDir)
      baseEnv.PATH = [shimDir, ...inheritedEntries].join(delimiter)
    }
  }

  // Why: GitHub attribution should only affect commands launched from
  // Orca's own PTYs. Injecting lightweight PATH shims at spawn-time keeps
  // the behavior local to Orca instead of rewriting user git config or
  // touching external shells.
  if (!opts.githubAttributionEnabled) {
    delete baseEnv.ORCA_ENABLE_GIT_ATTRIBUTION
    delete baseEnv.ORCA_GIT_COMMIT_TRAILER
    delete baseEnv.ORCA_GH_PR_FOOTER
    delete baseEnv.ORCA_GH_ISSUE_FOOTER
    delete baseEnv.ORCA_ATTRIBUTION_SHIM_DIR
  }
  applyTerminalAttributionEnv(baseEnv, {
    enabled: opts.githubAttributionEnabled,
    userDataPath: opts.userDataPath,
    shellFamily: resolveAttributionShellFamily({
      shellPath: opts.shellPath,
      isWsl: opts.isWsl
    })
  })

  return baseEnv
}

function isClaudeLaunchCommand(command: string | undefined): boolean {
  if (!command) {
    return false
  }
  return /(^|[\s;&|('"`])(?:[^\s;&|('"`]*[\\/])?claude(?:\.cmd|\.exe)?($|[\s;&|)'"`])/i.test(
    command
  )
}

function routesFreshSpawnsToLocalProvider(
  provider: IPtyProvider
): provider is FreshLocalFallbackProvider {
  return (provider as FreshLocalFallbackProvider).routesFreshSpawnsToLocalProvider === true
}

/** Register an SSH PTY provider for a connection. */
export function registerSshPtyProvider(connectionId: string, provider: IPtyProvider): void {
  sshProviders.set(connectionId, provider)
}

/** Remove an SSH PTY provider when a connection is closed. */
export function unregisterSshPtyProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
}

/** Get the SSH PTY provider for a connection (for dispose on cleanup). */
export function getSshPtyProvider(connectionId: string): IPtyProvider | undefined {
  return sshProviders.get(connectionId)
}

/** Get the installed PTY provider (for direct access in tests/runtime).
 *
 * Returns the installed PTY provider — after `setLocalPtyProvider()` runs
 * during daemon init this may be the routed adapter (specifically either
 * `DaemonPtyAdapter` or its `DaemonPtyRouter` wrapper). Callers needing
 * `LocalPtyProvider`-specific methods (`killOrphanedPtys`,
 * `advanceGeneration`, `getPtyProcess`) must type-narrow or import the
 * concrete class directly. */
export function getLocalPtyProvider(): IPtyProvider {
  return localProvider
}

/** Replace the local PTY provider with a daemon-backed one.
 *  Call before registerPtyHandlers so the IPC layer routes through the daemon. */
export function setLocalPtyProvider(provider: IPtyProvider): void {
  localProvider = provider
}

/** Get all PTY IDs owned by a given connectionId (for reconnection reattach). */
export function getPtyIdsForConnection(connectionId: string): string[] {
  const ids: string[] = []
  for (const [ptyId, connId] of ptyOwnership) {
    if (connId === connectionId) {
      ids.push(ptyId)
    }
  }
  return ids
}

/**
 * Remove all PTY ownership entries for a given connectionId.
 * Why: when an SSH connection is closed, the remote PTYs are gone but their
 * ownership entries linger. Without cleanup, subsequent spawn calls could
 * look up a stale provider for those PTY IDs, and the map grows unboundedly.
 */
export function clearPtyOwnershipForConnection(connectionId: string): void {
  for (const [ptyId, connId] of ptyOwnership) {
    if (connId === connectionId) {
      // Why: remote PTYs are gone after the SSH connection closes — their
      // paneKey-scoped caches (agent-hooks server, OpenCode, Pi) must be swept
      // the same way a local onExit would, otherwise they leak indefinitely
      // for the process lifetime.
      clearProviderPtyState(ptyId)
      ptyOwnership.delete(ptyId)
    }
  }
}

// ─── Provider-scoped PTY state cleanup ──────────────────────────────

export function clearProviderPtyState(id: string): void {
  // Why: OpenCode and Pi both allocate PTY-scoped runtime state outside the
  // node-pty process table. Centralizing provider cleanup avoids drift where a
  // new teardown path forgets to remove one provider's overlay/hook state.
  openCodeHookService.clearPty(id)
  piTitlebarExtensionService.clearPty(id)
  // Why: SSH exit and connection-teardown paths bypass pty.ts's local onExit
  // callback but still need to release Claude account-switch guards.
  markClaudePtyExited(id)
  ptySizes.delete(id)
  lastInputAtByPty.delete(id)
  interactiveOutputCharsByPty.delete(id)
  activeRendererPtys.delete(id)
  visibleRendererPtys.delete(id)
  rendererVisibilityKnownPtys.delete(id)
  pendingHiddenRendererResizeOutputPtys.delete(id)
  deliveredHiddenRendererResizeOutputPtys.delete(id)
  clearStartupTerminalColorQueryReplies(id)
  // Why: every PTY teardown path funnels through here (local exit, daemon
  // shutdown, SSH exit/connection teardown) — hidden/interest gate bits must
  // not outlive the PTY or a reused map entry could silently gate a new one.
  clearHiddenRendererPtyDeliveryState(id)
  clearBackgroundedDeliverySyncForPty(id)
  providerSnapshotRequiredPtys.delete(id)
  // Why: the Phase-5 ConPTY DA1 spawn record must not leak onto a reused id.
  clearNativeWindowsConptyPty(id)
  const paneKey = ptyPaneKey.get(id)
  const stillOwnsPaneKey = paneKey ? paneKeyPtyId.get(paneKey) === id : false
  // Why: drop the memory-collector registration so a dead PTY does not keep
  // trying to resolve its (now-dead) pid on every snapshot. Safe no-op for
  // PTYs that were never registered (SSH-owned).
  unregisterPty(id)
  // Why: cover lifecycle paths that bypass runtime.onPtyExit — SSH reattach
  // failures, SSH connection shutdown (clearPtyOwnershipForConnection), and
  // daemon spawn-failure cleanup all funnel through here. Without this the
  // watcher's per-PTY buffer and worktree binding outlive the PTY.
  advertisedUrlWatcher.unbindPty(id)
  clearMigrationUnsupportedPty(id)
  agentHookServer.clearPaneKeyAliasesForPty(id, {
    shouldClearStablePaneKey: (stablePaneKey) => {
      // Why: when this PTY never rebuilt ptyPaneKey after restart, alias
      // ownership is our only proof. Once a newer PTY owns the same stable
      // paneKey, alias teardown must not erase that newer status.
      const stablePaneOwner = paneKeyPtyId.get(stablePaneKey)
      if (stablePaneOwner && stablePaneOwner !== id) {
        return false
      }
      return !paneKey || (stillOwnsPaneKey && stablePaneKey === paneKey)
    }
  })
  rendererSerializerByPtyId.delete(id)
  // Why: the hook server's per-paneKey caches (lastPrompt / lastTool) would
  // otherwise accumulate entries for dead panes over the process lifetime.
  // Use the spawn-time paneKey mapping since the server has no other way to
  // correlate a ptyId back to its paneKey.
  if (paneKey) {
    if (stillOwnsPaneKey) {
      agentHookServer.clearPaneState(paneKey)
      paneKeyPtyId.delete(paneKey)
    }
    ptyPaneKey.delete(id)
    // Why: drop the pre-signal pending entry only if it still belongs to THIS
    // PTY's spawn generation. If a remount for the same paneKey has already
    // pre-signaled a new gen, this teardown must NOT touch it — otherwise
    // the second mount's hydration loses to the daemon-snapshot seed. See
    // the generation-token rationale in
    // docs/mobile-prefer-renderer-scrollback.md.
    const ownedGen = ptyPendingGenByPtyId.get(id)
    if (ownedGen !== undefined) {
      settlePendingPaneSerializer(paneKey, ownedGen)
    }
    ptyPendingGenByPtyId.delete(id)
    if (stillOwnsPaneKey) {
      // Why: notify registered consumers AFTER we've dropped the paneKey↔ptyId
      // entries so a listener that re-reads the map sees the post-teardown
      // state. Wrap each call so one throwing listener cannot block the rest.
      for (const listener of paneKeyTeardownListeners) {
        try {
          listener(paneKey)
        } catch (err) {
          console.error('[pty] paneKey teardown listener threw', err)
        }
      }
    }
  }
}

export function deletePtyOwnership(id: string): void {
  ptyOwnership.delete(id)
}

export function setPtyOwnership(id: string, connectionId: string | null): void {
  ptyOwnership.set(id, connectionId)
}

// Why: localProvider.onData/onExit return unsubscribe functions. Without
// storing and calling these on re-registration, macOS app re-activation
// creates a new BrowserWindow and re-calls registerPtyHandlers, leaking
// duplicate listeners that forward every event twice.
let localDataUnsub: (() => void) | null = null
let localExitUnsub: (() => void) | null = null
let localBackgroundStreamUnsub: (() => void) | null = null
let didFinishLoadHandler: (() => void) | null = null
let didFinishLoadWebContents: WebContents | null = null
let rendererLifecycleResetWebContents: WebContents | null = null
let rendererLifecycleResetHandler: (() => void) | null = null
// Why: the hidden-delivery gate's interest/hidden registries mirror renderer
// state (ref-counted holds, per-pane hidden marks). A reload or renderer
// crash destroys the owners without unregistering, so the registries are
// reset whenever the renderer process is replaced
// (resetRendererScopedHiddenPtyDeliveryState preserves drop memory).
let rendererGateResetLoadHandler: (() => void) | null = null
let rendererGateResetGoneHandler: (() => void) | null = null
let rendererGateResetWebContents: WebContents | null = null
// Why: the backgrounded-delivery dedupe map lives in the registerPtyHandlers
// closure but teardown funnels through module-scope clearProviderPtyState.
let clearBackgroundedDeliverySyncForPty: (id: string) => void = () => {}
// Why: after daemon keep-tail thinning, main's mirror contains only the kept
// tail. Recovery must keep consulting the daemon's complete model until exit.
const providerSnapshotRequiredPtys = new Set<string>()
// Why: did-start-loading also fires for in-page subframe loads (e.g. the
// sandboxed srcDoc iframes notebook HTML output renders), which are not renderer
// lifecycle resets. A dedicated handler filters those via isLoadingMainFrame so a
// subframe load cannot reset delivery accounting on the still-alive page.
let rendererDidStartLoadingHandler: (() => void) | null = null

// Why: the "Restart daemon" path needs to re-bind provider→renderer listeners
// against the freshly-created adapter after replaceDaemonProvider swaps the
// module-level `localProvider` pointer. Without this, old subscribers stay
// bound to the disposed adapter and new PTY data silently drops. Saved at
// module scope so the restart flow (src/main/daemon/daemon-init.ts) can
// trigger a rebind without re-running the full registerPtyHandlers setup.
let rebindProviderListeners: (() => void) | null = null

export function rebindLocalProviderListeners(): void {
  rebindProviderListeners?.()
}

export type PtyRendererDeliveryDebugSnapshot = {
  pendingPtyCount: number
  pendingChars: number
  maxPendingCharsByPty: number
  rendererInFlightPtyCount: number
  rendererInFlightChars: number
  maxRendererInFlightCharsByPty: number
  activeRendererPtyCount: number
  flushScheduled: boolean
  peakPendingChars: number
  peakMaxPendingCharsByPty: number
  peakRendererInFlightChars: number
  peakMaxRendererInFlightCharsByPty: number
  ackGatedFlushSkipCount: number
  hiddenDeliveryGatedPtyCount: number
  /** Hidden-gated ptys the renderer ALSO reports visible/active — a
   *  contradiction that should be zero; nonzero means the user may be staring
   *  at a pane main is deliberately starving (v1.4.124-rc.2.perf field lead). */
  hiddenDeliveryGatedVisiblePtyCount: number
  hiddenDeliveryGatedActivePtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
  pendingDroppedChars: number
  /** One-paste freeze diagnostics: per-pty delivery table + event history. */
  diagnostics: PtyMainDeliveryDiagnostics
  // Why: a nonzero lastLifecycleResetClearedChars is the exact signature of the
  // leaked-delivery-accounting freeze this reset fixes; the count tracks how
  // many renderer lifecycle resets have run since launch.
  rendererLifecycleResetCount: number
  lastLifecycleResetClearedChars: number
  // Why: the boot-window hold early-returns before ackGatedFlushSkipCount++, so
  // without these a held gate is invisible in the snapshot; forcedCount > 0 flags
  // that the watchdog self-healed a lost handshake.
  rendererPtyDispatcherReady: boolean
  rendererDispatcherReadyForcedCount: number
}

// Why module scope: breadcrumb writers live both inside registerPtyHandlers
// (gate marks, heals) and outside it (renderer lifecycle resets).
const mainDeliveryBreadcrumbs = createPtyDeliveryBreadcrumbRing()
let lastPowerSuspendAtMs: number | null = null
let lastPowerResumeAtMs: number | null = null
let powerSignalBreadcrumbsInstalled = false

// Why: both field freeze variants correlate with display sleep; suspend/resume
// timestamps in the report let us line breadcrumbs up against the wake.
function installPowerSignalBreadcrumbs(): void {
  if (powerSignalBreadcrumbsInstalled) {
    return
  }
  powerSignalBreadcrumbsInstalled = true
  powerMonitor.on('suspend', () => {
    lastPowerSuspendAtMs = Date.now()
    mainDeliveryBreadcrumbs.record('power-suspend')
  })
  powerMonitor.on('resume', () => {
    lastPowerResumeAtMs = Date.now()
    mainDeliveryBreadcrumbs.record('power-resume')
  })
}

const EMPTY_PTY_RENDERER_DELIVERY_DEBUG_SNAPSHOT: PtyRendererDeliveryDebugSnapshot = {
  pendingPtyCount: 0,
  pendingChars: 0,
  maxPendingCharsByPty: 0,
  rendererInFlightPtyCount: 0,
  rendererInFlightChars: 0,
  maxRendererInFlightCharsByPty: 0,
  activeRendererPtyCount: 0,
  flushScheduled: false,
  peakPendingChars: 0,
  peakMaxPendingCharsByPty: 0,
  peakRendererInFlightChars: 0,
  peakMaxRendererInFlightCharsByPty: 0,
  ackGatedFlushSkipCount: 0,
  hiddenDeliveryGatedPtyCount: 0,
  hiddenDeliveryGatedVisiblePtyCount: 0,
  hiddenDeliveryGatedActivePtyCount: 0,
  deliveryInterestPtyCount: 0,
  hiddenDeliveryDroppedChars: 0,
  hiddenDeliveryDroppedChunks: 0,
  pendingDroppedChars: 0,
  diagnostics: EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
  rendererLifecycleResetCount: 0,
  lastLifecycleResetClearedChars: 0,
  rendererPtyDispatcherReady: false,
  rendererDispatcherReadyForcedCount: 0
}

let readPtyRendererDeliveryDebugSnapshot = (): PtyRendererDeliveryDebugSnapshot => ({
  ...EMPTY_PTY_RENDERER_DELIVERY_DEBUG_SNAPSHOT
})
let resetPtyRendererDeliveryDebugSnapshot = (): void => {}
// Bridged into the registerPtyHandlers closure (like readPtyRendererDeliveryDebugSnapshot)
// so the module-scope lifecycle-reset handler can zero the closure-owned delivery
// accounting on a renderer reload/crash.
let resetRendererDeliveryAccountingForLifecycleReset = (): void => {}
// Bridged so a re-registration (new window) can cancel the prior closure's
// dispatcher-ready watchdog before wiring up its own.
let clearRendererDispatcherReadyWatchdog = (): void => {}

export function getPtyRendererDeliveryDebugSnapshot(): PtyRendererDeliveryDebugSnapshot {
  return readPtyRendererDeliveryDebugSnapshot()
}

export function resetPtyRendererDeliveryDebug(): void {
  resetPtyRendererDeliveryDebugSnapshot()
}

function clearDidFinishLoadHandler(): void {
  if (didFinishLoadHandler && didFinishLoadWebContents) {
    didFinishLoadWebContents.removeListener('did-finish-load', didFinishLoadHandler)
  }
  didFinishLoadHandler = null
  didFinishLoadWebContents = null
}

function markRendererPtysHiddenForRendererLifecycleReset(): void {
  // A reload/crash in the history is load-bearing context for any freeze
  // report ("did the user already reload before capturing?").
  mainDeliveryBreadcrumbs.record('renderer-lifecycle-reset')
  // Why: renderer-owned hints die with the page; keep known-visibility state so
  // surviving daemon/SSH PTYs fail closed until the new renderer reports again.
  activeRendererPtys.clear()
  visibleRendererPtys.clear()
  // Why: the dead page never ACKs its in-flight bytes, so leaked in-flight/pending
  // accounting would delivery-gate surviving PTYs forever after a reload/crash.
  resetRendererDeliveryAccountingForLifecycleReset()
}

function clearRendererLifecycleResetHandlers(): void {
  if (!rendererLifecycleResetWebContents) {
    return
  }
  if (rendererDidStartLoadingHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'did-start-loading',
      rendererDidStartLoadingHandler
    )
  }
  if (rendererLifecycleResetHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'render-process-gone',
      rendererLifecycleResetHandler
    )
    rendererLifecycleResetWebContents.removeListener('destroyed', rendererLifecycleResetHandler)
  }
  rendererLifecycleResetWebContents = null
  rendererLifecycleResetHandler = null
  rendererDidStartLoadingHandler = null
}

function registerRendererLifecycleResetHandlers(webContents: WebContents): void {
  clearRendererLifecycleResetHandlers()
  markRendererPtysHiddenForRendererLifecycleReset()
  rendererLifecycleResetWebContents = webContents
  rendererLifecycleResetHandler = markRendererPtysHiddenForRendererLifecycleReset
  // Why: did-start-loading also fires for in-page subframe loads (sandboxed
  // srcDoc iframes in notebook HTML output), where isLoadingMainFrame() is false.
  // Only a main-frame load is a real renderer lifecycle reset; filtering here
  // stops a subframe load from clearing pendingData and holding the send gate
  // (a spurious multi-second freeze) on the otherwise-alive page.
  rendererDidStartLoadingHandler = () => {
    if (!webContents.isLoadingMainFrame()) {
      return
    }
    markRendererPtysHiddenForRendererLifecycleReset()
  }
  webContents.on('did-start-loading', rendererDidStartLoadingHandler)
  webContents.on('render-process-gone', rendererLifecycleResetHandler)
  webContents.on('destroyed', rendererLifecycleResetHandler)
}

function clearRendererGateResetHandlers(): void {
  if (rendererGateResetWebContents) {
    if (rendererGateResetLoadHandler) {
      rendererGateResetWebContents.removeListener('did-finish-load', rendererGateResetLoadHandler)
    }
    if (rendererGateResetGoneHandler) {
      rendererGateResetWebContents.removeListener(
        'render-process-gone',
        rendererGateResetGoneHandler
      )
    }
  }
  rendererGateResetLoadHandler = null
  rendererGateResetGoneHandler = null
  rendererGateResetWebContents = null
}

// Why: the "Restart daemon" flow needs to detach listeners from the current
// adapter *after* synthetic pty:exit events fan out (so the renderer receives
// them) but *before* replaceDaemonProvider swaps in the new adapter (so the
// new provider isn't missing bindings). This export narrows that window to
// the caller.
export function unbindLocalProviderListeners(): void {
  localDataUnsub?.()
  localExitUnsub?.()
  localBackgroundStreamUnsub?.()
  localDataUnsub = null
  localExitUnsub = null
  localBackgroundStreamUnsub = null
}

// ─── IPC Registration ───────────────────────────────────────────────

export function registerPtyHandlers(
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store,
  options?: {
    awaitLocalPtyStartup?: () => Promise<void>
    // Why: returns true (once, consuming the flag) for the crash-recovery reload
    // so its did-finish-load skips the orphan sweep and keeps live PTYs (#5787).
    isRecoveryReloadInFlight?: (webContentsId: number) => boolean
  }
): void {
  // Why: a re-registration means a new window owns delivery. Cancel any watchdog the
  // prior closure armed, and neutralize its bridged reset so the registration-time
  // mark-hidden below can't arm a timer against the now-dead closure — the fresh
  // closure re-installs both bridges once its state is set up.
  clearRendererDispatcherReadyWatchdog()
  resetRendererDeliveryAccountingForLifecycleReset = () => {}
  registerRendererLifecycleResetHandlers(mainWindow.webContents)

  const getLocalPtyStartupPromise = (connectionId?: string | null): Promise<void> | undefined => {
    if (connectionId) {
      return undefined
    }
    // Why: during desktop cold start the daemon provider swap now overlaps
    // first paint. Local spawns must wait before resolving getProvider(), while
    // SSH/headless paths do not use the desktop daemon.
    return options?.awaitLocalPtyStartup?.()
  }

  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:listSessions')
  ipcMain.removeHandler('pty:hasPty')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeHandler('pty:confirmForegroundProcess')
  ipcMain.removeHandler('pty:getCwd')
  ipcMain.removeHandler('pty:getSize')
  ipcMain.removeHandler('pty:declarePendingPaneSerializer')
  ipcMain.removeHandler('pty:settlePaneSerializer')
  ipcMain.removeHandler('pty:clearPendingPaneSerializer')
  ipcMain.removeHandler('pty:getMainBufferSnapshot')
  ipcMain.removeHandler('pty:sideEffectSnapshot')
  ipcMain.removeHandler('pty:getRendererDeliveryDebugSnapshot')
  ipcMain.removeHandler('pty:resetRendererDeliveryDebug')
  ipcMain.removeHandler('pty:reportRendererDeliveryState')
  ipcMain.removeHandler('pty:writeAccepted')
  ipcMain.removeAllListeners('pty:write')
  ipcMain.removeAllListeners('pty:ackColdRestore')
  ipcMain.removeAllListeners('pty:ackData')
  ipcMain.removeAllListeners('pty:deliveryResyncResponse')
  ipcMain.removeAllListeners('pty:serializeBuffer:response')

  // Configure the local provider with app-specific hooks.
  // Why: only LocalPtyProvider has the configure() method — daemon-backed
  // providers handle subprocess spawning internally and don't need main-process
  // hook injection. The hooks (buildSpawnEnv, onSpawned, etc.) only make sense
  // when the PTY lives in the Electron main process.
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.configure({
      isHistoryEnabled: () => getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
      getWindowsShell: () => getSettings?.()?.terminalWindowsShell,
      getWindowsPowerShellImplementation: () =>
        getSettings
          ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
          : undefined,
      pwshAvailable: () => isPwshAvailable(),
      buildSpawnEnv: (id, baseEnv, ctx) => {
        const codexSelectionTarget: CodexAccountSelectionTarget =
          ctx?.isWsl === true
            ? { runtime: 'wsl', wslDistro: ctx.wslDistro ?? null }
            : { runtime: 'host' }
        const selectedCodexHomePath = getCompatibleSelectedCodexHomePath(
          codexSelectionTarget,
          getSelectedCodexHomePath?.(codexSelectionTarget) ?? null
        )
        const env = buildPtyHostEnv(id, baseEnv, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath,
          skipCodexHomeEnv: ctx?.isWsl === true && !selectedCodexHomePath,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false,
          launchCommand: ctx?.command,
          shellPath: ctx?.shellPath,
          isWsl: ctx?.isWsl,
          wslDistro: ctx?.wslDistro ?? null,
          agentStatusHooksEnabled: isAgentStatusHooksEnabled(getSettings?.()),
          networkProxySettings: getSettings?.()
        })
        // Why: agents need their own terminal handle at process start so they
        // can self-identify in orchestration messages without an extra RPC.
        const requestedHandle = baseEnv.ORCA_TERMINAL_HANDLE
        const preAllocatedHandle =
          requestedHandle && trustedTerminalHandleEnv.has(requestedHandle)
            ? requestedHandle
            : runtime?.preAllocateHandleForPty(id)
        if (requestedHandle && requestedHandle !== preAllocatedHandle) {
          delete env.ORCA_TERMINAL_HANDLE
        }
        if (preAllocatedHandle) {
          env.ORCA_TERMINAL_HANDLE = preAllocatedHandle
        }
        if (ctx?.isWsl === true) {
          addOrcaWslInteropEnv(env)
        }
        return env
      },
      onSpawned: (id) => runtime?.onPtySpawned(id),
      onExit: (id, code) => {
        clearProviderPtyState(id)
        ptyOwnership.delete(id)
        markClaudePtyExited(id)
        runtime?.onPtyExit(id, code)
      },
      onData: (id, data, timestamp) => runtime?.onPtyData(id, data, timestamp)
    })
  }

  // Why: batching PTY data into short flush windows (8ms ≈ half a frame)
  // reduces IPC round-trips from hundreds/sec to ~120/sec under high
  // throughput. Keystroke echo/redraws bypass this below because agent TUIs
  // already spend tens of ms producing their redraw.
  type PendingPtyData = {
    data: string
    startSeq?: number
    containsBackgroundOutput?: boolean
    // Why droppedOutput (not main's droppedBacklog trim): this branch bounds
    // the unsent backlog with the O(1) drop-to-sentinel + query-salvage +
    // snapshot-restore mechanism below, which strictly supersedes main's
    // #7630 keep-2MB-tail trim — carrying both would race two cap policies
    // over the same buffer.
    droppedOutput?: true
  }

  type PtyDataPayload = {
    id: string
    data: string
    seq?: number
    rawLength?: number
    background?: boolean
    droppedOutput?: boolean
  }

  const pendingData = new Map<string, PendingPtyData>()
  // Why: one restore marker per overflow episode — cleared when the entry
  // fully drains so a later overflow re-marks the renderer exactly once.
  const pendingOverflowMarkedPtys = new Set<string>()
  // Why: TCP-style cumulative delivery accounting. Relative in-flight counters
  // make every lost ACK a permanent debt; monotonic sent/acked totals self-heal
  // as soon as any later ACK (or resync reply) reports the renderer's full
  // processed count.
  type RendererPtyDeliveryAccounting = {
    sentChars: number
    ackedChars: number
    lastSendAtMs: number
    lastAckAtMs: number | null
  }
  const rendererDeliveryAccountingByPty = new Map<string, RendererPtyDeliveryAccounting>()
  const trustedTerminalHandleEnv = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let rendererInFlightTotalChars = 0
  let pendingDroppedChars = 0
  let deliveryResyncRequestSerial = 0
  let deliveryResyncOutstandingRequestId: number | null = null
  let deliveryResyncTimer: ReturnType<typeof setTimeout> | null = null
  let deliveryResyncUnansweredWarnLogged = false
  let lastAckReceivedAtMs: number | null = null
  // Why 2ms: pairs with the daemon stream batcher (see
  // daemon-stream-data-batcher.ts) — both hops charged an expected
  // half-window per chunk; 2ms keeps flood coalescing at negligible IPC
  // overhead while cutting the pipeline's fixed latency tax.
  const PTY_BATCH_INTERVAL_MS = 2
  const PTY_BATCH_DRAIN_CONTINUE_MS = 1
  const PTY_BATCH_FLUSH_CHUNK_CHARS = 16 * 1024
  const PTY_BATCH_FLUSH_MAX_WRITES = 2
  const PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS = 512 * 1024
  const PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS = 8 * 1024 * 1024
  // Why: while the renderer cannot receive (frozen, starved, mid-reload), a
  // chatty PTY used to grow its pendingData string without bound — main-process
  // heap ballooning that a renderer reload cannot clear (main's #7630 fixed the
  // same Win/Linux background-throttled-renderer leak with a 2MB tail trim;
  // this branch's sentinel mechanism supersedes it). Beyond this cap the
  // buffered bytes are dropped and the pane heals from the main-owned buffer
  // snapshot via the droppedOutput sentinel (renderer hidden-output restore).
  // Why read settings live: the cap scales with the user's scrollback setting
  // so power users don't lose lines their scrollback would have retained.
  const pendingDataCapChars = (): number =>
    terminalOutputBacklogCapChars(getSettings?.().terminalScrollbackRows)
  // Why: self-heal bound for the dispatcher-ready gate — if a reloaded page never
  // sends pty:rendererDispatcherReady (lost IPC), force sends back on after this
  // window so a dropped handshake can't itself become a permanent hold.
  const PTY_DISPATCHER_READY_WATCHDOG_MS = 10_000
  const PTY_RENDERER_INTERACTIVE_RESERVE_CHARS = 256 * 1024
  // Why: active panes need a bounded lane through old hidden bulk output so a
  // keystroke redraw can reach the renderer before every background ACK lands.
  const PTY_RENDERER_ACTIVE_PTY_IN_FLIGHT_RESERVE_CHARS = 512 * 1024
  // Why: request/response hygiene only — this timeout never mutates delivery
  // state. It clears the outstanding-probe flag so a later gated arrival can
  // probe again, and logs once per silent streak for field diagnosis.
  const PTY_DELIVERY_RESYNC_TIMEOUT_MS = 5_000
  // Why: a heal write-off destroys delivery accounting; require main to have
  // seen zero ACKs for this long too, independent of the renderer's own
  // two-silent-ticks evidence, before believing the channel is dead.
  const PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS = 10_000
  // Why: keep the immediate path bounded to keystroke-sized TUI redraws;
  // large output and non-interactive output must still use the batcher.
  const INTERACTIVE_OUTPUT_WINDOW_MS = 100
  const INTERACTIVE_OUTPUT_MAX_CHARS = 1024
  const INTERACTIVE_REDRAW_MAX_CHARS = PTY_BATCH_FLUSH_CHUNK_CHARS
  const INTERACTIVE_OUTPUT_BUDGET_CHARS = 32 * 1024
  let peakPendingChars = 0
  let peakMaxPendingCharsByPty = 0
  let peakRendererInFlightChars = 0
  let peakMaxRendererInFlightCharsByPty = 0
  let ackGatedFlushSkipCount = 0
  let rendererLifecycleResetCount = 0
  let lastLifecycleResetClearedChars = 0
  // Why: how many times the watchdog force-opened the gate because no handshake
  // arrived; nonzero flags a dropped-handshake self-heal (degrades to pre-§1b
  // behavior, observable + recoverable at the next reset, never a freeze).
  let rendererDispatcherReadyForcedCount = 0
  // Why: gate sends until the current page's pty:data listener is registered.
  // A reloaded/first-load page has no listener yet, so webContents.send drops
  // the bytes but still counts them in-flight, permanently pinning the gate.
  // Flipped true by the pty:rendererDispatcherReady handshake, reset false on
  // every lifecycle reset (below); starts false so nothing sends pre-handshake.
  let rendererPtyDispatcherReady = false
  let dispatcherReadyWatchdogTimer: ReturnType<typeof setTimeout> | null = null

  // Why: watermark-driven producer pause/resume (terminal-performance
  // initiative §5). Signal source is per-PTY pendingData only — renderer
  // in-flight is already bounded by the ACK window above, while pendingData
  // is what grows without bound when the renderer cannot keep up. Providers
  // without support (SSH, legacy daemon protocol) surface no pauseProducer
  // and the call chain no-ops; the pending cap still bounds memory then.
  const producerFlowControl = new PtyProducerFlowController({
    pauseProducer: (id) => tryGetProviderForPty(id)?.pauseProducer?.(id),
    resumeProducer: (id) => tryGetProviderForPty(id)?.resumeProducer?.(id)
  })

  function updateProducerFlowControl(id: string): void {
    if (!PRODUCER_FLOW_CONTROL_ENABLED) {
      return
    }
    producerFlowControl.update(id, pendingData.get(id)?.data.length ?? 0)
  }

  // Why this exists: hidden ptys are exempt from pendingData flow control
  // (their bytes are dropped after model ingestion, so pendingData never
  // grows), which let background agents run 100MB+ ahead of main in the
  // daemon's stream-socket buffer and bury the visible pane's echo. The
  // provider transport keep-tail thins backgrounded ptys' monitoring stream
  // under backlog; this sync tells it which ptys qualify.
  // Why keyed on the visibility registry (NOT gate marks or gate-effective
  // shouldDrop): delivery claims and raw-byte sidecars describe transport
  // ownership, while thinning asks the semantic question "does any visible
  // view show this PTY?" Remote view subscribers (mobile/web live terminals)
  // consume raw bytes from main's fan-out, so their presence vetoes thinning
  // outright. Dedupe keeps visibility-sync churn off the wire; `?? false`
  // also swallows the initial
  // not-background state.
  const backgroundedDeliverySyncByPty = new Map<string, boolean>()
  function syncPtyBackgroundedDelivery(id: string, caller: string): void {
    const background =
      rendererPtyIsKnownHidden(id) && !(runtime?.hasRemoteTerminalViewSubscriber(id) ?? false)
    if ((backgroundedDeliverySyncByPty.get(id) ?? false) === background) {
      return
    }
    const provider = tryGetProviderForPty(id)
    if (!provider?.setPtyBackgrounded) {
      return
    }
    recordDaemonStreamBacklogEvent('mainBackgroundSync', {
      sessionIdSuffix: id.slice(-10),
      background,
      caller,
      known: rendererVisibilityKnownPtys.has(id),
      visible: visibleRendererPtys.has(id)
    })
    backgroundedDeliverySyncByPty.set(id, background)
    provider.setPtyBackgrounded(id, background)
  }
  clearBackgroundedDeliverySyncForPty = (id: string) => {
    backgroundedDeliverySyncByPty.delete(id)
  }
  if (runtime) {
    runtime.onRemoteTerminalViewPresenceChanged = (id) =>
      syncPtyBackgroundedDelivery(id, 'remote-view')
  }
  function resyncBackgroundedDeliveriesAfterGateReset(): void {
    for (const id of backgroundedDeliverySyncByPty.keys()) {
      syncPtyBackgroundedDelivery(id, 'gate-reset')
    }
  }

  function getRendererInFlightCharsForPty(id: string): number {
    const accounting = rendererDeliveryAccountingByPty.get(id)
    return accounting ? accounting.sentChars - accounting.ackedChars : 0
  }

  function readCurrentPtyRendererDeliveryDebugSnapshot(): PtyRendererDeliveryDebugSnapshot {
    let pendingChars = 0
    let maxPendingCharsByPty = 0
    for (const pending of pendingData.values()) {
      const chars = pending.data.length
      pendingChars += chars
      maxPendingCharsByPty = Math.max(maxPendingCharsByPty, chars)
    }
    const hiddenDeliveryDebug = getHiddenRendererPtyDeliveryDebug()
    let rendererInFlightPtyCount = 0
    let maxRendererInFlightCharsByPty = 0
    for (const accounting of rendererDeliveryAccountingByPty.values()) {
      const inFlight = accounting.sentChars - accounting.ackedChars
      if (inFlight > 0) {
        rendererInFlightPtyCount++
      }
      maxRendererInFlightCharsByPty = Math.max(maxRendererInFlightCharsByPty, inFlight)
    }
    // Why: the two renderer visibility signals must agree; a pty both
    // hidden-gated and reported visible means main is starving a pane the
    // user can see (v1.4.124-rc.2.perf blank-terminal field lead).
    let hiddenDeliveryGatedVisiblePtyCount = 0
    for (const id of visibleRendererPtys) {
      if (isHiddenRendererPty(id)) {
        hiddenDeliveryGatedVisiblePtyCount++
      }
    }
    let hiddenDeliveryGatedActivePtyCount = 0
    for (const id of activeRendererPtys) {
      if (isHiddenRendererPty(id)) {
        hiddenDeliveryGatedActivePtyCount++
      }
    }
    return {
      pendingPtyCount: pendingData.size,
      pendingChars,
      maxPendingCharsByPty,
      rendererInFlightPtyCount,
      rendererInFlightChars: rendererInFlightTotalChars,
      maxRendererInFlightCharsByPty,
      activeRendererPtyCount: activeRendererPtys.size,
      flushScheduled: flushTimer !== null,
      peakPendingChars,
      peakMaxPendingCharsByPty,
      peakRendererInFlightChars,
      peakMaxRendererInFlightCharsByPty,
      ackGatedFlushSkipCount,
      ...hiddenDeliveryDebug,
      hiddenDeliveryGatedVisiblePtyCount,
      hiddenDeliveryGatedActivePtyCount,
      pendingDroppedChars,
      diagnostics: buildMainDeliveryDiagnostics(),
      rendererLifecycleResetCount,
      lastLifecycleResetClearedChars,
      rendererPtyDispatcherReady,
      rendererDispatcherReadyForcedCount
    }
  }

  const DELIVERY_DIAGNOSTICS_MAX_PTYS = 30

  // Built only when the debug snapshot is actually read — never on the data
  // path. Aggregate counters can't say WHICH pty is wedged or WHEN the state
  // arose; this per-pty table + both-process breadcrumb history can.
  function buildMainDeliveryDiagnostics(): PtyMainDeliveryDiagnostics {
    const now = Date.now()
    // Hidden/visible/active set members are included even with no accounting
    // entry: a pty gated before its first byte is exactly the wedge case the
    // table must surface.
    const ids = new Set([
      ...rendererDeliveryAccountingByPty.keys(),
      ...pendingData.keys(),
      ...getHiddenRendererPtyIds(),
      ...visibleRendererPtys,
      ...activeRendererPtys
    ])
    const perPty: PtyPerPtyDeliveryDiagnostics[] = []
    for (const id of ids) {
      const accounting = rendererDeliveryAccountingByPty.get(id)
      perPty.push({
        id: redactPtyIdForDiagnostics(id),
        sentChars: accounting?.sentChars ?? 0,
        ackedChars: accounting?.ackedChars ?? 0,
        inFlightChars: accounting ? accounting.sentChars - accounting.ackedChars : 0,
        pendingChars: pendingData.get(id)?.data.length ?? 0,
        hidden: isHiddenRendererPty(id),
        visible: visibleRendererPtys.has(id),
        active: activeRendererPtys.has(id),
        msSinceLastSend: accounting ? now - accounting.lastSendAtMs : null,
        msSinceLastAck: accounting?.lastAckAtMs == null ? null : now - accounting.lastAckAtMs
      })
    }
    perPty.sort((a, b) => b.inFlightChars + b.pendingChars - (a.inFlightChars + a.pendingChars))
    const windowAlive = !mainWindow.isDestroyed()
    return {
      appVersion: app.getVersion(),
      mainUptimeMs: Math.round(process.uptime() * 1000),
      windowFocused: windowAlive ? mainWindow.isFocused() : null,
      windowVisible: windowAlive ? mainWindow.isVisible() : null,
      windowMinimized: windowAlive ? mainWindow.isMinimized() : null,
      msSinceLastPowerSuspend: lastPowerSuspendAtMs === null ? null : now - lastPowerSuspendAtMs,
      msSinceLastPowerResume: lastPowerResumeAtMs === null ? null : now - lastPowerResumeAtMs,
      perPty: perPty.slice(0, DELIVERY_DIAGNOSTICS_MAX_PTYS),
      breadcrumbs: mainDeliveryBreadcrumbs.snapshot()
    }
  }

  // Why rate-limited: the contradiction persists chunk after chunk while
  // latched; one line per minute keeps field logs readable but present.
  let lastHiddenDropContradictionWarnAtMs = 0
  function warnIfDroppingHiddenBytesForVisiblePty(id: string, droppedChars: number): void {
    if (!visibleRendererPtys.has(id) && !activeRendererPtys.has(id)) {
      return
    }
    // Recorded before the warn rate limit: the ring coalesces repeats itself,
    // and the contradiction must appear in the freeze report either way.
    mainDeliveryBreadcrumbs.record('hidden-drop-visible', {
      id: redactPtyIdForDiagnostics(id),
      droppedChars
    })
    const now = Date.now()
    if (now - lastHiddenDropContradictionWarnAtMs < 60_000) {
      return
    }
    lastHiddenDropContradictionWarnAtMs = now
    console.warn('[pty] hidden-delivery gate is dropping bytes for a visible/active pty', {
      id,
      droppedChars,
      visible: visibleRendererPtys.has(id),
      active: activeRendererPtys.has(id),
      ...readCurrentPtyRendererDeliveryDebugSnapshot()
    })
  }

  function recordPtyRendererDeliveryPressure(): void {
    // Why: this fires on every PTY delivery event (per send, per flush, per
    // onData append). Update the four diagnostic peaks directly instead of
    // allocating a full 13-field debug snapshot object per call — that object
    // is only needed when the debug getter is actually read. Peak values are
    // computed identically to readCurrentPtyRendererDeliveryDebugSnapshot.
    let pendingChars = 0
    let maxPendingCharsByPty = 0
    for (const pending of pendingData.values()) {
      const chars = pending.data.length
      pendingChars += chars
      maxPendingCharsByPty = Math.max(maxPendingCharsByPty, chars)
    }
    peakPendingChars = Math.max(peakPendingChars, pendingChars)
    peakMaxPendingCharsByPty = Math.max(peakMaxPendingCharsByPty, maxPendingCharsByPty)
    peakRendererInFlightChars = Math.max(peakRendererInFlightChars, rendererInFlightTotalChars)
    // Why derived per entry: this branch tracks cumulative sent/acked totals
    // (TCP-style), not a per-pty in-flight map — in-flight is the difference.
    let maxRendererInFlightCharsByPty = 0
    for (const accounting of rendererDeliveryAccountingByPty.values()) {
      maxRendererInFlightCharsByPty = Math.max(
        maxRendererInFlightCharsByPty,
        accounting.sentChars - accounting.ackedChars
      )
    }
    peakMaxRendererInFlightCharsByPty = Math.max(
      peakMaxRendererInFlightCharsByPty,
      maxRendererInFlightCharsByPty
    )
  }

  readPtyRendererDeliveryDebugSnapshot = readCurrentPtyRendererDeliveryDebugSnapshot
  resetPtyRendererDeliveryDebugSnapshot = () => {
    peakPendingChars = 0
    peakMaxPendingCharsByPty = 0
    peakRendererInFlightChars = 0
    peakMaxRendererInFlightCharsByPty = 0
    ackGatedFlushSkipCount = 0
    pendingDroppedChars = 0
    resetHiddenRendererPtyDeliveryDebugCounters()
    recordPtyRendererDeliveryPressure()
  }
  resetRendererDeliveryAccountingForLifecycleReset = () => {
    // Why: clearing pendingData is lossless — its bytes were only ever bound for
    // the dead page, and the replacement page repaints each pane from main's
    // authoritative sources (daemon snapshot / headless buffer / cold-restore),
    // which are fed before the pendingData append so they always superset it.
    lastLifecycleResetClearedChars = rendererInFlightTotalChars
    rendererLifecycleResetCount += 1
    // Why: pending bytes and outstanding credits belonged to the dead page.
    // Release producer pauses before clearing them so no shell stays wedged.
    producerFlowControl.releaseAll()
    clearDeliveryResyncProbe()
    deliveryResyncUnansweredWarnLogged = false
    rendererDeliveryAccountingByPty.clear()
    rendererInFlightTotalChars = 0
    pendingData.clear()
    pendingOverflowMarkedPtys.clear()
    // Why: the reloading page's pty:data listener is gone until it re-registers
    // and re-sends the handshake; hold sends until then so the boot window can't
    // re-pin the gate with bytes dropped into a listener-less page.
    rendererPtyDispatcherReady = false
    // Why: arm the self-heal watchdog so a never-arriving handshake can't leave the
    // gate held forever; the real handshake cancels it.
    armDispatcherReadyWatchdog()
    recordPtyRendererDeliveryPressure()
  }
  // Why: let a later re-registration cancel this closure's watchdog (armed via a
  // hoisted fn, so this bridge assignment can precede its definition).
  clearRendererDispatcherReadyWatchdog = clearDispatcherReadyWatchdog

  function isLikelyInteractiveRedraw(data: string): boolean {
    if (data.length <= INTERACTIVE_OUTPUT_MAX_CHARS) {
      return true
    }
    // Why: Codex-style TUIs can repaint more than 1 KB per keypress. ANSI
    // control redraws are still latency-sensitive, while plain command output
    // should stay on the throughput batch path.
    return data.length <= INTERACTIVE_REDRAW_MAX_CHARS && data.includes('\x1b[')
  }

  function shouldSendInteractiveOutputNow(id: string, data: string, now: number): boolean {
    const lastInputAt = lastInputAtByPty.get(id)
    if (lastInputAt === undefined || now - lastInputAt > INTERACTIVE_OUTPUT_WINDOW_MS) {
      interactiveOutputCharsByPty.delete(id)
      return false
    }
    if (!isLikelyInteractiveRedraw(data)) {
      interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    const usedChars = interactiveOutputCharsByPty.get(id) ?? 0
    if (usedChars + data.length > INTERACTIVE_OUTPUT_BUDGET_CHARS) {
      interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    interactiveOutputCharsByPty.set(id, usedChars + data.length)
    return true
  }

  function getChunkStartSeq(endSeq: number | undefined, data: string): number | undefined {
    return typeof endSeq === 'number' ? Math.max(0, endSeq - data.length) : undefined
  }

  function makePtyDataPayload(
    id: string,
    data: string,
    startSeq: number | undefined,
    containsBackgroundOutput: boolean | undefined
  ): PtyDataPayload {
    const payload: PtyDataPayload = { id, data }
    if (typeof startSeq === 'number') {
      payload.seq = startSeq + data.length
      payload.rawLength = data.length
    }
    if (containsBackgroundOutput === true) {
      payload.background = true
    }
    return payload
  }

  function getPtyPayloadCharCount(payload: { data: string; rawLength?: number }): number {
    return Math.max(0, payload.rawLength ?? payload.data.length)
  }

  function canSendPtyDataToRenderer(id: string, options: { interactive?: boolean } = {}): boolean {
    const totalLimit =
      PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS +
      (options.interactive === true ? PTY_RENDERER_INTERACTIVE_RESERVE_CHARS : 0)
    // Why: the reserve is per active PTY, not global; one active pane should
    // stay responsive without letting every background pane burst past the cap.
    const ptyLimit =
      PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS +
      (options.interactive === true ? PTY_RENDERER_ACTIVE_PTY_IN_FLIGHT_RESERVE_CHARS : 0)
    return getRendererInFlightCharsForPty(id) < ptyLimit && rendererInFlightTotalChars < totalLimit
  }

  // Why: max-merge on cumulative totals is idempotent and reorder-tolerant —
  // a replayed or out-of-order ACK can never double-credit, and a lost ACK
  // self-heals when any later ACK reports the full processed count. Returns
  // the newly acknowledged delta so provider (SSH/daemon) backpressure is only
  // credited for bytes main actually tracked in flight, never negative.
  function applyCumulativeAck(id: string, processedChars: number): number {
    const accounting = rendererDeliveryAccountingByPty.get(id)
    if (!accounting) {
      return 0
    }
    // Clamped to sentChars so a corrupt payload cannot drive in-flight negative.
    const nextAckedChars = Math.min(
      accounting.sentChars,
      Math.max(accounting.ackedChars, processedChars)
    )
    const acknowledged = nextAckedChars - accounting.ackedChars
    accounting.ackedChars = nextAckedChars
    if (acknowledged > 0) {
      accounting.lastAckAtMs = Date.now()
    }
    rendererInFlightTotalChars = Math.max(0, rendererInFlightTotalChars - acknowledged)
    return acknowledged
  }

  function clearDeliveryResyncProbe(): void {
    deliveryResyncOutstandingRequestId = null
    if (deliveryResyncTimer) {
      clearTimeout(deliveryResyncTimer)
      deliveryResyncTimer = null
    }
  }

  // Why: event-triggered verified-state recovery. Data arriving for a fully
  // gated PTY is the deterministic signal that delivery may be stuck on lost
  // ACKs (e.g. dropped across a system suspend); ask the renderer for its
  // authoritative processed totals instead of resetting on a wall-clock guess.
  function requestDeliveryResyncForGatedPty(): void {
    if (deliveryResyncOutstandingRequestId !== null || mainWindow.isDestroyed()) {
      return
    }
    deliveryResyncRequestSerial += 1
    const requestId = deliveryResyncRequestSerial
    deliveryResyncOutstandingRequestId = requestId
    deliveryResyncTimer = setTimeout(() => {
      if (deliveryResyncOutstandingRequestId !== requestId) {
        return
      }
      clearDeliveryResyncProbe()
      // Why: no state mutation on timeout — a renderer that cannot answer has
      // dead IPC, and only a reload cures that. Log once per silent streak so
      // field diagnosis is captured without spamming every probe cycle.
      if (deliveryResyncUnansweredWarnLogged) {
        return
      }
      deliveryResyncUnansweredWarnLogged = true
      console.warn('[pty] delivery resync probe unanswered — renderer IPC unresponsive', {
        msSinceLastAck: lastAckReceivedAtMs === null ? null : Date.now() - lastAckReceivedAtMs,
        ...readCurrentPtyRendererDeliveryDebugSnapshot()
      })
    }, PTY_DELIVERY_RESYNC_TIMEOUT_MS)
    deliveryResyncTimer.unref?.()
    mainWindow.webContents.send('pty:requestDeliveryResync', { requestId })
  }

  // Why: bytes sent but never counted received by the renderer after a
  // confirmed wedge are gone — no ACK message can ever repay them (unlike a
  // lost ACK, which any later cumulative total heals). Write the debt off and
  // hand back restore markers so panes repaint from the main-owned snapshot;
  // the caller routes them locally because push markers cannot arrive.
  function writeOffLostRendererDelivery(
    report: PtyRendererDeliveryStateReport
  ): PtyDeliveryWriteOff[] {
    const writtenOff: PtyDeliveryWriteOff[] = []
    for (const [id, accounting] of rendererDeliveryAccountingByPty) {
      if (accounting.sentChars - accounting.ackedChars <= 0) {
        continue
      }
      const received = report.receivedCharsByPty?.[id]
      const receivedChars =
        typeof received === 'number' && Number.isFinite(received) ? Math.max(0, received) : 0
      // Why skip a parse-pending window: received-but-unparsed bytes sit alive
      // in the renderer write queue; their deferred ACK still repays this debt.
      if (receivedChars > accounting.ackedChars) {
        continue
      }
      const acknowledged = applyCumulativeAck(id, accounting.sentChars)
      if (acknowledged <= 0) {
        continue
      }
      tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
      // Why drop pending: everything at or before markerSeq comes from the
      // snapshot (hidden-drop parity); flushing pre-marker bytes afterward
      // would double-paint what the restore already covers.
      const pending = pendingData.get(id)
      if (pending) {
        pendingDroppedChars += pending.data.length
        pendingData.delete(id)
        pendingOverflowMarkedPtys.delete(id)
        updateProducerFlowControl(id)
      }
      const markerSeq = runtime?.getPtyOutputSequence(id)
      writtenOff.push({
        id,
        ...(typeof markerSeq === 'number' ? { markerSeq } : {}),
        writtenOffChars: acknowledged
      })
    }
    if (writtenOff.length > 0) {
      clearDeliveryResyncProbe()
      deliveryResyncUnansweredWarnLogged = false
      mainDeliveryBreadcrumbs.record('delivery-heal-writeoff', {
        writtenOffPtyCount: writtenOff.length,
        writtenOffChars: writtenOff.reduce((sum, { writtenOffChars }) => sum + writtenOffChars, 0)
      })
      console.warn('[pty] delivery heal: wrote off renderer-bound bytes lost in push channel', {
        rendererPtyDataListenerCount: report.rendererPtyDataListenerCount ?? null,
        msSinceLastAck: lastAckReceivedAtMs === null ? null : Date.now() - lastAckReceivedAtMs,
        writtenOffByPty: writtenOff.map(({ id, writtenOffChars }) => ({ id, writtenOffChars })),
        ...readCurrentPtyRendererDeliveryDebugSnapshot()
      })
    }
    return writtenOff
  }

  function sendPtyDataToRenderer(id: string, payload: PtyDataPayload): void {
    const charCount = getPtyPayloadCharCount(payload)
    const accounting = rendererDeliveryAccountingByPty.get(id)
    if (accounting) {
      accounting.sentChars += charCount
      accounting.lastSendAtMs = Date.now()
    } else {
      rendererDeliveryAccountingByPty.set(id, {
        sentChars: charCount,
        ackedChars: 0,
        lastSendAtMs: Date.now(),
        lastAckAtMs: null
      })
    }
    rendererInFlightTotalChars += charCount
    recordPtyRendererDeliveryPressure()
    mainWindow.webContents.send('pty:data', payload)
  }

  function rendererPtyIsKnownHidden(id: string): boolean {
    return rendererVisibilityKnownPtys.has(id) && !visibleRendererPtys.has(id)
  }

  function ptyHasHiddenRendererResizeOutput(id: string): boolean {
    return (
      pendingHiddenRendererResizeOutputPtys.has(id) ||
      deliveredHiddenRendererResizeOutputPtys.has(id)
    )
  }

  function markHiddenRendererResizeOutputDelivered(id: string): void {
    if (!pendingHiddenRendererResizeOutputPtys.delete(id)) {
      return
    }
    deliveredHiddenRendererResizeOutputPtys.add(id)
  }

  function clearDeliveredHiddenRendererResizeOutput(id: string): void {
    deliveredHiddenRendererResizeOutputPtys.delete(id)
  }

  function clearHiddenRendererResizeOutput(id: string): void {
    pendingHiddenRendererResizeOutputPtys.delete(id)
    deliveredHiddenRendererResizeOutputPtys.delete(id)
  }

  // Why: when main drops renderer delivery (hidden gate / pending cap), an
  // explicit out-of-band pty:modelRestoreNeeded signal tells the renderer to
  // latch model-restore-needed. It must NOT ride pty:data: an in-band empty
  // chunk is indistinguishable from a chunk fully consumed by renderer-side
  // OSC-9999 stripping, which spuriously restored visible panes.
  function sendModelRestoreNeededMarker(
    id: string,
    reason: PtyModelRestoreReason,
    markerSeq: number | undefined
  ): void {
    if (mainWindow.isDestroyed()) {
      return
    }
    mainWindow.webContents.send('pty:modelRestoreNeeded', {
      id,
      reason,
      ...(typeof markerSeq === 'number' ? { markerSeq } : {})
    })
  }

  function getPendingPtyFlushEntries(): [string, PendingPtyData][] {
    const entries = Array.from(pendingData.entries())
    const active: [string, PendingPtyData][] = []
    const background: [string, PendingPtyData][] = []
    for (const entry of entries) {
      if (activeRendererPtys.has(entry[0])) {
        active.push(entry)
      } else {
        background.push(entry)
      }
    }
    return [...active, ...background]
  }

  const pendingDataDropWarnedPtys = new Set<string>()

  // Why capped: the drop path guarantees O(1) memory per PTY; salvaged query
  // bytes are tiny (a DSR probe is 4 chars) and anything past the cap means a
  // pathological stream, where degrading to the plain sentinel is fine.
  const DROPPED_QUERY_SALVAGE_MAX_CHARS = 4096

  // Why: a bulk drop must not swallow reply-eliciting queries embedded in the
  // flood (DSR 6n / CPR, DA1/DA2, DECRQM, OSC 10/11 probes). The program that
  // wrote them blocks on the reply (the bench DSR timeout). Carve just the
  // query bytes out and let them ride the droppedOutput sentinel — content is
  // healed by the snapshot restore, so replies cannot double-fire.
  function extractDroppedPtyQueryBytes(data: string): string {
    if (!data.includes('\x1b')) {
      return ''
    }
    const extracted = extractHiddenStartupRendererQueryData(data, '')
    return extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
  }

  function dropOversizedPendingPtyData(id: string, pending: PendingPtyData): PendingPtyData {
    const capChars = pendingDataCapChars()
    if (pending.droppedOutput === true || pending.data.length <= capChars) {
      return pending
    }
    if (!pendingDataDropWarnedPtys.has(id)) {
      pendingDataDropWarnedPtys.add(id)
      console.error(
        `[pty] dropped ${pending.data.length} buffered chars for ${id}: renderer not receiving and per-PTY pending cap exceeded; pane will restore from the main-owned snapshot`
      )
      // Why: field visibility for cap tuning — drop frequency and size decide
      // whether the cap is too small (issue #2836 / #7017). No pty id: session
      // ids can embed workspace paths.
      recordCrashBreadcrumb('terminal_pending_output_dropped', {
        droppedChars: pending.data.length,
        capChars
      })
    }
    // Why: with the hidden-delivery gate rolled out, the model snapshot can
    // recover the dropped middle — emit the out-of-band restore marker once
    // per overflow episode alongside the droppedOutput sentinel so a fresh
    // or reloaded view latches restore too.
    if (isHiddenPtyDeliveryGateEnabled(getSettings?.()) && !pendingOverflowMarkedPtys.has(id)) {
      pendingOverflowMarkedPtys.add(id)
      sendModelRestoreNeededMarker(id, 'pending-cap', runtime?.getPtyOutputSequence(id))
    }
    pendingDroppedChars += pending.data.length
    // Why no trimmed content tail: a mid-stream gap would silently corrupt
    // the pane. The droppedOutput sentinel routes the pane through
    // hidden-output restore, which repaints from the authoritative main-owned
    // buffer and realigns with the live stream by sequence. Only carved-out
    // query bytes ride along so their replies survive the drop.
    return {
      data: extractDroppedPtyQueryBytes(pending.data).slice(0, DROPPED_QUERY_SALVAGE_MAX_CHARS),
      droppedOutput: true
    }
  }

  function appendPendingPtyData(
    id: string,
    existing: PendingPtyData | undefined,
    data: string,
    startSeq: number | undefined,
    preservesSeq: boolean,
    containsBackgroundOutput: boolean
  ): PendingPtyData {
    // Why: once over the cap, stay dropped at O(1) memory until the renderer
    // can receive again — the restore sentinel supersedes any interim bytes.
    // Queries arriving while latched still get carved out (bounded) so their
    // replies survive the whole drop episode, not just the first burst.
    if (existing?.droppedOutput === true) {
      if (existing.data.length >= DROPPED_QUERY_SALVAGE_MAX_CHARS) {
        return existing
      }
      const salvaged = extractDroppedPtyQueryBytes(data)
      return salvaged ? { ...existing, data: existing.data + salvaged } : existing
    }
    const nextContainsBackgroundOutput =
      existing?.containsBackgroundOutput === true || containsBackgroundOutput
    if (!preservesSeq) {
      return dropOversizedPendingPtyData(id, {
        data: (existing?.data ?? '') + data,
        ...(nextContainsBackgroundOutput ? { containsBackgroundOutput: true } : {})
      })
    }
    if (!existing) {
      return dropOversizedPendingPtyData(id, {
        data,
        ...(typeof startSeq === 'number' ? { startSeq } : {}),
        ...(nextContainsBackgroundOutput ? { containsBackgroundOutput: true } : {})
      })
    }
    const next: PendingPtyData = {
      data: existing.data + data,
      ...(nextContainsBackgroundOutput ? { containsBackgroundOutput: true } : {})
    }
    if (typeof existing.startSeq === 'number') {
      next.startSeq = existing.startSeq
    }
    return dropOversizedPendingPtyData(id, next)
  }

  function schedulePendingDataFlush(delayMs: number): void {
    if (flushTimer) {
      return
    }
    flushTimer = setTimeout(flushPendingData, delayMs)
  }

  function clearDispatcherReadyWatchdog(): void {
    if (dispatcherReadyWatchdogTimer) {
      clearTimeout(dispatcherReadyWatchdogTimer)
      dispatcherReadyWatchdogTimer = null
    }
  }

  function armDispatcherReadyWatchdog(): void {
    clearDispatcherReadyWatchdog()
    if (mainWindow.isDestroyed()) {
      return
    }
    // Why: one-shot self-heal — if the reloaded page never signals ready, force the
    // gate open so a dropped handshake degrades to pre-handshake behavior (bounded
    // duplicate/overwrite at worst) instead of a permanent hold. Unref'd so it can
    // never keep the process alive.
    dispatcherReadyWatchdogTimer = setTimeout(() => {
      dispatcherReadyWatchdogTimer = null
      if (rendererPtyDispatcherReady || mainWindow.isDestroyed()) {
        return
      }
      rendererPtyDispatcherReady = true
      rendererDispatcherReadyForcedCount += 1
      schedulePendingDataFlush(0)
    }, PTY_DISPATCHER_READY_WATCHDOG_MS)
    dispatcherReadyWatchdogTimer.unref?.()
  }

  function flushPendingData(): void {
    flushTimer = null
    if (mainWindow.isDestroyed()) {
      // Why: the bookkeeping is being wiped, so no future drain can ever
      // resume these producers — release them now or local shells wedge.
      producerFlowControl.releaseAll()
      clearDeliveryResyncProbe()
      pendingData.clear()
      pendingOverflowMarkedPtys.clear()
      rendererDeliveryAccountingByPty.clear()
      rendererInFlightTotalChars = 0
      clearDispatcherReadyWatchdog()
      recordPtyRendererDeliveryPressure()
      return
    }
    // Why: hold sends until the page's pty:data listener is registered. Bytes
    // keep accruing in pendingData (2 MB cap + droppedBacklog rebuild it
    // losslessly); the ready handshake reschedules this flush.
    if (!rendererPtyDispatcherReady) {
      return
    }
    const settings = getSettings?.()
    let writes = 0
    for (const [id, pending] of getPendingPtyFlushEntries()) {
      if (writes >= PTY_BATCH_FLUSH_MAX_WRITES) {
        break
      }
      // Why: hidden-gated bytes are dropped, never re-queued — the model
      // already ingested them; reveal restores from the snapshot+seq machinery.
      if (shouldDropHiddenRendererPtyData(id, settings)) {
        pendingData.delete(id)
        pendingOverflowMarkedPtys.delete(id)
        updateProducerFlowControl(id)
        const drop = recordHiddenRendererPtyDataDrop(id, pending.data.length)
        warnIfDroppingHiddenBytesForVisiblePty(id, pending.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(id, 'hidden-drop', runtime?.getPtyOutputSequence(id))
        }
        continue
      }
      if (!canSendPtyDataToRenderer(id, { interactive: activeRendererPtys.has(id) })) {
        continue
      }
      pendingData.delete(id)
      if (pending.droppedOutput === true) {
        updateProducerFlowControl(id)
        // Why: the buffered bytes were dropped at the pending cap; tell the
        // renderer so the pane repaints from the main-owned buffer snapshot
        // instead of continuing a stream with a silent gap. data carries only
        // the carved-out query bytes (see extractDroppedPtyQueryBytes).
        sendPtyDataToRenderer(id, { id, data: pending.data, droppedOutput: true })
        writes++
        continue
      }
      const { data } = pending
      const chunk = data.slice(0, PTY_BATCH_FLUSH_CHUNK_CHARS)
      const remaining = data.slice(PTY_BATCH_FLUSH_CHUNK_CHARS)
      if (remaining) {
        const nextPending: PendingPtyData = { data: remaining }
        if (typeof pending.startSeq === 'number') {
          nextPending.startSeq = pending.startSeq + chunk.length
        }
        if (pending.containsBackgroundOutput === true) {
          nextPending.containsBackgroundOutput = true
        }
        pendingData.set(id, nextPending)
      } else {
        pendingOverflowMarkedPtys.delete(id)
      }
      updateProducerFlowControl(id)
      sendPtyDataToRenderer(
        id,
        makePtyDataPayload(id, chunk, pending.startSeq, pending.containsBackgroundOutput)
      )
      writes++
    }
    if (pendingData.size > 0 && writes === 0) {
      ackGatedFlushSkipCount++
    }
    recordPtyRendererDeliveryPressure()
    if (pendingData.size > 0 && writes > 0) {
      // Why: a background terminal can dump megabytes at once. Yield between
      // small IPC slices so keystroke writes are not stuck behind one flush.
      schedulePendingDataFlush(PTY_BATCH_DRAIN_CONTINUE_MS)
    }
  }

  const clearFlushTimerIfIdle = (): void => {
    if (pendingData.size > 0 || flushTimer === null) {
      return
    }
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const syntheticKillExitPtyIds = new Map<string, NodeJS.Timeout>()

  function rememberSyntheticKillExit(id: string): void {
    const existing = syntheticKillExitPtyIds.get(id)
    if (existing) {
      clearTimeout(existing)
    }
    // Why: some providers can report the real exit after kill has already
    // completed; skip only that late duplicate, not a future reused id forever.
    const cleanupTimer = setTimeout(() => {
      syntheticKillExitPtyIds.delete(id)
    }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
    cleanupTimer.unref?.()
    syntheticKillExitPtyIds.set(id, cleanupTimer)
  }

  function consumeSyntheticKillExit(id: string): boolean {
    const cleanupTimer = syntheticKillExitPtyIds.get(id)
    if (!cleanupTimer) {
      return false
    }
    clearTimeout(cleanupTimer)
    syntheticKillExitPtyIds.delete(id)
    return true
  }

  function sendPtyExitToRenderer(payload: { id: string; code: number }): void {
    if (mainWindow.isDestroyed()) {
      return
    }
    // Why: flush any batched data for this PTY before sending the exit event,
    // otherwise the last <=8ms of output is silently lost because the renderer
    // tears down the terminal on pty:exit before the batch timer fires.
    const remaining = pendingData.get(payload.id)
    if (remaining) {
      if (remaining.droppedOutput === true) {
        // Sentinel entry: only salvaged query bytes remain; keep the flag so
        // the renderer knows the span was dropped (same as the flush loop).
        sendPtyDataToRenderer(payload.id, {
          id: payload.id,
          data: remaining.data,
          droppedOutput: true
        })
      } else {
        sendPtyDataToRenderer(
          payload.id,
          makePtyDataPayload(
            payload.id,
            remaining.data,
            remaining.startSeq,
            remaining.containsBackgroundOutput
          )
        )
      }
      pendingData.delete(payload.id)
    }
    // Why: exit drops this PTY's bookkeeping; resume (no-op on a dead PTY)
    // rather than leave a stale paused mark behind for a reused id.
    producerFlowControl.release(payload.id)
    pendingOverflowMarkedPtys.delete(payload.id)
    lastInputAtByPty.delete(payload.id)
    interactiveOutputCharsByPty.delete(payload.id)
    rendererInFlightTotalChars = Math.max(
      0,
      rendererInFlightTotalChars - getRendererInFlightCharsForPty(payload.id)
    )
    // Why: the renderer also drops its cumulative total on pty:exit, so a
    // reused id restarts aligned at zero on both sides.
    rendererDeliveryAccountingByPty.delete(payload.id)
    recordPtyRendererDeliveryPressure()
    mainWindow.webContents.send('pty:exit', payload)
  }

  async function shutdownProviderAndDetectExit(
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean }
  ): Promise<boolean> {
    let providerExitObserved = false
    const unsubscribe = provider.onExit((payload) => {
      if (payload.id === id) {
        providerExitObserved = true
      }
    })
    try {
      await provider.shutdown(id, opts)
    } finally {
      unsubscribe()
    }
    return providerExitObserved
  }

  // Why: extracted so the "Restart daemon" flow can rebind against the fresh
  // adapter after replaceDaemonProvider runs. Both the startup registration
  // and the post-restart rebind go through the same code path — no risk of
  // drift between the two entry points.
  const bindProviderListeners = (): void => {
    localDataUnsub?.()
    localExitUnsub?.()
    localBackgroundStreamUnsub?.()

    // Keep-tail thinning facts from the daemon, in byte order with onData.
    // The marker flips scan authority for the four transient-fact scanners;
    // a gap resets main's cross-chunk parse state and forces the renderer to
    // restore from the model snapshot (same seq-guard path as hidden drops)
    // in case any view — eager buffer included — was receiving bytes.
    localBackgroundStreamUnsub =
      localProvider.onBackgroundStreamEvent?.((payload) => {
        if (payload.kind === 'backgroundMarker') {
          runtime?.setPtyTransientFactDelegation(
            payload.id,
            payload.background,
            payload.scanSeedAnsi
          )
          return
        }
        if (payload.kind === 'dataGap') {
          providerSnapshotRequiredPtys.add(payload.id)
          runtime?.notePtyDataGap(payload.id, payload.sequenceChars ?? payload.droppedChars)
          sendModelRestoreNeededMarker(
            payload.id,
            'hidden-drop',
            runtime?.getPtyOutputSequence(payload.id)
          )
          return
        }
        runtime?.emitDaemonPtyTransientFact(payload.id, payload.fact)
      }) ?? null

    // Why: LocalPtyProvider routes data to the runtime via configure().onData,
    // but daemon-backed providers don't have configure(). Without this, daemon
    // PTY data never reaches the runtime's tail buffer, so terminal.read returns
    // empty and agent-detection from raw data never fires. Runtime tails also
    // power mobile read/stream, so they must be notified regardless of window
    // state.
    const isLocalProvider = localProvider instanceof LocalPtyProvider

    localDataUnsub = localProvider.onData((payload) => {
      const outputSeq = isLocalProvider
        ? runtime?.getPtyOutputSequence(payload.id)
        : runtime?.onPtyData(
            payload.id,
            payload.data,
            Date.now(),
            payload.sequenceChars ?? payload.data.length
          )
      const rendererData = answerStartupTerminalColorQueriesForPty(payload.id, payload.data)
      const preservesSeq =
        rendererData === payload.data &&
        (payload.sequenceChars === undefined || payload.sequenceChars === payload.data.length)
      const startSeq = preservesSeq ? getChunkStartSeq(outputSeq, payload.data) : undefined
      if (mainWindow.isDestroyed()) {
        // Why: clear the pending flush timer so it doesn't fire after the window
        // is gone. Without this, macOS app re-activation leaks orphaned timers
        // from the previous window's registration.
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        producerFlowControl.releaseAll()
        clearDeliveryResyncProbe()
        pendingData.clear()
        pendingOverflowMarkedPtys.clear()
        rendererDeliveryAccountingByPty.clear()
        rendererInFlightTotalChars = 0
        clearDispatcherReadyWatchdog()
        recordPtyRendererDeliveryPressure()
        return
      }
      const settings = getSettings?.()
      // Why: hidden-delivery gate — runtime ingestion above already consumed
      // the chunk; gated renderer delivery is DROPPED (never queued) and the
      // reveal path restores from the model snapshot via the seq guard. The
      // drop sits before the interactive bypass so gated PTYs take neither
      // the immediate nor the batched renderer path.
      if (shouldDropHiddenRendererPtyData(payload.id, settings)) {
        const drop = recordHiddenRendererPtyDataDrop(payload.id, payload.data.length)
        warnIfDroppingHiddenBytesForVisiblePty(payload.id, payload.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(payload.id, 'hidden-drop', outputSeq)
        }
        return
      }
      if (rendererData.length === 0) {
        return
      }
      const containsBackgroundOutput =
        rendererPtyIsKnownHidden(payload.id) || ptyHasHiddenRendererResizeOutput(payload.id)
      if (containsBackgroundOutput) {
        markHiddenRendererResizeOutputDelivered(payload.id)
      }
      const existing = pendingData.get(payload.id)
      const pending = appendPendingPtyData(
        payload.id,
        existing,
        rendererData,
        startSeq,
        preservesSeq,
        containsBackgroundOutput
      )
      const nextData = pending.data
      const isInteractiveOutput = shouldSendInteractiveOutputNow(
        payload.id,
        nextData,
        performance.now()
      )
      // Why: gate the interactive fast path on the dispatcher handshake too, so
      // boot-window keystroke echo accrues in pendingData instead of being sent
      // into a listener-less page and pinning the gate.
      if (isInteractiveOutput && rendererPtyDispatcherReady) {
        // Why: user-input echo should not be pinned behind unrelated bulk
        // terminal output already handed to the renderer. The reserve is
        // bounded, and the per-PTY cap still prevents an active TUI runaway.
        if (!canSendPtyDataToRenderer(payload.id, { interactive: true })) {
          requestDeliveryResyncForGatedPty()
          pendingData.set(payload.id, pending)
          updateProducerFlowControl(payload.id)
          recordPtyRendererDeliveryPressure()
          return
        }
        pendingData.delete(payload.id)
        updateProducerFlowControl(payload.id)
        pendingOverflowMarkedPtys.delete(payload.id)
        clearFlushTimerIfIdle()
        // Why: agent TUIs redraw small prompt regions after every keystroke.
        // Waiting for the throughput batch timer adds visible input latency.
        sendPtyDataToRenderer(payload.id, {
          id: payload.id,
          data: nextData,
          ...(typeof pending.startSeq === 'number'
            ? { seq: pending.startSeq + nextData.length, rawLength: nextData.length }
            : {}),
          ...(pending.containsBackgroundOutput === true ? { background: true } : {}),
          ...(pending.droppedOutput === true ? { droppedOutput: true } : {})
        })
        return
      }
      pendingData.set(payload.id, pending)
      updateProducerFlowControl(payload.id)
      recordPtyRendererDeliveryPressure()
      // Why: probe on data arrival, not on flush skips — new output for a
      // fully gated PTY is the moment stuck delivery becomes observable.
      if (
        !canSendPtyDataToRenderer(payload.id, { interactive: activeRendererPtys.has(payload.id) })
      ) {
        requestDeliveryResyncForGatedPty()
      }
      if (!flushTimer) {
        schedulePendingDataFlush(PTY_BATCH_INTERVAL_MS)
      }
    })
    localExitUnsub = localProvider.onExit((payload) => {
      if (consumeSyntheticKillExit(payload.id)) {
        return
      }
      if (!isLocalProvider) {
        clearProviderPtyState(payload.id)
        ptyOwnership.delete(payload.id)
        markClaudePtyExited(payload.id)
        runtime?.onPtyExit(payload.id, payload.code)
      }
      sendPtyExitToRenderer(payload)
    })
  }

  bindProviderListeners()
  rebindProviderListeners = bindProviderListeners

  // Why: a persistent ipcMain listener with a request-ID dispatch table
  // (instead of one listener per call) so concurrent serialize requests do
  // not stack listeners and trip Node's MaxListeners=10 warning. Many
  // sleeping PTYs waking at once (e.g. on relaunch) routinely fan out 10+
  // concurrent calls.
  type SerializeResult = { data: string; cols: number; rows: number; lastTitle?: string } | null
  const pendingSerializeRequests = new Map<
    string,
    { resolve: (result: SerializeResult) => void; timeout: NodeJS.Timeout }
  >()

  function settleSerializeRequest(requestId: string, result: SerializeResult): void {
    const pending = pendingSerializeRequests.get(requestId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeout)
    pendingSerializeRequests.delete(requestId)
    pending.resolve(result)
  }

  ipcMain.on(
    'pty:serializeBuffer:response',
    (
      _event,
      args: {
        requestId?: string
        snapshot?: {
          data?: unknown
          cols?: unknown
          rows?: unknown
          lastTitle?: unknown
        } | null
      }
    ) => {
      if (typeof args?.requestId !== 'string') {
        return
      }
      const snapshot = args.snapshot
      if (
        snapshot &&
        typeof snapshot.data === 'string' &&
        typeof snapshot.cols === 'number' &&
        typeof snapshot.rows === 'number'
      ) {
        const result: { data: string; cols: number; rows: number; lastTitle?: string } = {
          data: snapshot.data,
          cols: snapshot.cols,
          rows: snapshot.rows
        }
        if (typeof snapshot.lastTitle === 'string' && snapshot.lastTitle.length > 0) {
          result.lastTitle = snapshot.lastTitle
        }
        settleSerializeRequest(args.requestId, result)
      } else {
        settleSerializeRequest(args.requestId, null)
      }
    }
  )

  function requestSerializedBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
  ): Promise<SerializeResult> {
    if (mainWindow.isDestroyed()) {
      return Promise.resolve(null)
    }

    const requestId = randomUUID()
    return new Promise<SerializeResult>((resolve) => {
      const timeout = setTimeout(() => {
        settleSerializeRequest(requestId, null)
      }, 750)
      pendingSerializeRequests.set(requestId, { resolve, timeout })
      const payload: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      } = { requestId, ptyId }
      if (opts) {
        payload.opts = opts
      }
      mainWindow.webContents.send('pty:serializeBuffer:request', payload)
    })
  }

  // Why: a reload (did-finish-load) or renderer crash replaces the process
  // that owned every delivery-interest hold and hidden mark; surviving
  // daemon/SSH PTYs would otherwise stay force-fed (leaked interest defeats
  // the gate) or stay gated against a renderer that never marked them. Drop
  // memory is preserved — each pane's first sync re-marks/unmarks and the
  // unmark path re-emits the restore marker for unrestored drops.
  clearRendererGateResetHandlers()
  rendererGateResetLoadHandler = () => {
    resetRendererScopedHiddenPtyDeliveryState()
    // Why: the daemon pacer must not keep throttling ptys whose hidden marks
    // died with the renderer; the fresh renderer's first visibility sync
    // re-marks the ones that are still hidden.
    resyncBackgroundedDeliveriesAfterGateReset()
  }
  rendererGateResetGoneHandler = () => {
    resetRendererScopedHiddenPtyDeliveryState()
    resyncBackgroundedDeliveriesAfterGateReset()
  }
  rendererGateResetWebContents = mainWindow.webContents
  mainWindow.webContents.on('did-finish-load', rendererGateResetLoadHandler)
  mainWindow.webContents.on('render-process-gone', rendererGateResetGoneHandler)

  // Kill orphaned PTY processes from previous page loads when the renderer reloads.
  // Why: only applies to LocalPtyProvider where PTYs live in the Electron main
  // process and can become orphaned on page reload. Daemon-backed sessions
  // survive renderer restarts by design — orphan cleanup would kill them.
  clearDidFinishLoadHandler()
  if (localProvider instanceof LocalPtyProvider) {
    const lp = localProvider
    didFinishLoadHandler = () => {
      // Why: always advance so the load generation stays monotonic, but skip the
      // sweep (and its per-PTY cleanup) on the crash/freeze-recovery reload — it
      // would kill live LOCAL PTYs across the single window before session
      // restore re-attaches them (#5787). The getter consumes the flag, so the
      // next genuine reload still reclaims genuinely-orphaned PTYs.
      const generation = lp.advanceGeneration()
      if (options?.isRecoveryReloadInFlight?.(mainWindow.webContents.id)) {
        return
      }
      const killed = lp.killOrphanedPtys(generation - 1)
      for (const { id } of killed) {
        clearProviderPtyState(id)
        ptyOwnership.delete(id)
        markClaudePtyExited(id)
        runtime?.onPtyExit(id, -1)
      }
    }
    didFinishLoadWebContents = mainWindow.webContents
    mainWindow.webContents.on('did-finish-load', didFinishLoadHandler)
  }

  const assertFolderWorkspacePtyPathUsable = async (
    worktreeId: string | undefined
  ): Promise<void> => {
    const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
    if (!store || workspaceScope?.type !== 'folder') {
      return
    }
    const status = await getFolderWorkspacePathStatus(
      store,
      { scope: 'folder-workspace', folderWorkspaceId: workspaceScope.folderWorkspaceId },
      { getSshFilesystemProvider }
    )
    assertFolderWorkspacePathUsable(status)
  }

  const resolvePtySpawnStartupCwd = (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ): string | undefined =>
    resolveTerminalStartupCwdForWorkspace({
      workspaceId: worktreeId,
      requestedCwd: cwd,
      missingDirFallback,
      resolveFolderWorkspacePath: (folderWorkspaceId) =>
        store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
    })

  const localStartupCwdDirectoryExists = (path: string): boolean => {
    // Why: Win32 statSync on \\wsl.localhost 9P shares can falsely report
    // ENOENT for directories that exist on the Linux side; never fall back on
    // that signal — the provider's WSL-aware validation decides instead.
    if (isWslUncPath(path)) {
      return true
    }
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  // Why: the runtime controller must route through getProviderForPty() so that
  // CLI commands (terminal.send, terminal.stop) work for both local and remote PTYs.
  // Hardcoding localProvider.getPtyProcess() would silently fail for remote PTYs.
  runtime?.setPtyController({
    spawn: async (args) => {
      const startupPromise = getLocalPtyStartupPromise(args.connectionId)
      if (startupPromise) {
        await startupPromise
      }
      await assertFolderWorkspacePtyPathUsable(args.worktreeId)
      const cwd = resolvePtySpawnStartupCwd(args.worktreeId, args.cwd)
      const provider = getProvider(args.connectionId)
      const isClaudeLaunch = !args.connectionId && isClaudeLaunchCommand(args.command)
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      // Why: runtime-created terminals do not carry renderer-computed
      // projectRuntime, so resolve from worktreeId to honor project Windows runtime.
      const terminalRuntimeOptions =
        process.platform === 'win32' && !args.connectionId
          ? resolveLocalWindowsTerminalRuntimeOptions({
              requestedShellOverride: undefined,
              settings: getSettings?.(),
              projectRuntime: resolveLocalProjectRuntimeForWorktreeId(store, args.worktreeId),
              fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
            })
          : { shellOverride: undefined, terminalWindowsWslDistro: null }
      const daemonShellOverride = terminalRuntimeOptions.shellOverride
      const codexSelectionTarget = getCodexSelectionTargetForPty(
        daemonShellOverride,
        cwd,
        terminalRuntimeOptions.terminalWindowsWslDistro ?? null
      )
      const claudeAuth =
        isClaudeLaunch && prepareClaudeAuth ? await prepareClaudeAuth(codexSelectionTarget) : null
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      if (claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
        throw new Error(
          'This Claude launch defines explicit Anthropic auth environment variables. Remove those overrides before using a managed Claude account.'
        )
      }

      const isDaemonHostSpawn =
        !args.connectionId &&
        !(provider instanceof LocalPtyProvider) &&
        !routesFreshSpawnsToLocalProvider(provider)
      const requestedSessionId = args.sessionId?.trim()
      const sessionId =
        requestedSessionId ?? (isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
      const effectiveSessionRelayId =
        sessionId !== undefined ? getRelayPtyId(args.connectionId, sessionId) : undefined
      const effectiveSessionAppId =
        sessionId !== undefined ? getAppPtyId(args.connectionId, sessionId) : undefined
      const isMintedSessionId = requestedSessionId === undefined && isDaemonHostSpawn
      const shouldPersistHostSessionBinding = args.persistHostSessionBinding === true
      let hostSessionBinding: {
        store: NonNullable<typeof store>
        worktreeId: string
        tabId: string
        leafId: string
      } | null = null
      if (shouldPersistHostSessionBinding) {
        if (
          !store ||
          typeof args.worktreeId !== 'string' ||
          typeof args.tabId !== 'string' ||
          !isValidTerminalTabId(args.tabId) ||
          typeof args.leafId !== 'string' ||
          !isTerminalLeafId(args.leafId)
        ) {
          throw new Error(
            'Cannot persist runtime PTY binding without worktreeId, tabId, and leafId'
          )
        }
        hostSessionBinding = {
          store,
          worktreeId: args.worktreeId,
          tabId: args.tabId,
          leafId: args.leafId
        }
      }
      const sshScopedEnv = stripRemotePaneEnvWhenHooksDisabled(args.connectionId, args.env)
      let env: Record<string, string> | undefined = claudeAuth
        ? { ...sshScopedEnv, ...claudeAuth.envPatch }
        : sshScopedEnv
      const requestedAgentTeamsPath = env?.ORCA_AGENT_TEAMS_TEAM_ID ? env.PATH : undefined
      if (args.preAllocatedHandle) {
        env = { ...env, ORCA_TERMINAL_HANDLE: args.preAllocatedHandle }
      }
      const selectedCodexHomePath = isDaemonHostSpawn
        ? getCompatibleSelectedCodexHomePath(
            codexSelectionTarget,
            getSelectedCodexHomePath?.(codexSelectionTarget) ?? null
          )
        : null
      const skipCodexHomeEnv =
        isDaemonHostSpawn &&
        shouldSkipCodexHomeEnvForWindowsShell(daemonShellOverride, cwd) &&
        !selectedCodexHomePath
      if (isDaemonHostSpawn && sessionId) {
        if (!isSafePtySessionId(sessionId, app.getPath('userData'))) {
          throw new Error('Invalid PTY session id')
        }
        env = buildPtyHostEnv(sessionId, env ?? {}, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath,
          skipCodexHomeEnv,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false,
          launchCommand: args.command,
          shellPath: daemonShellOverride ?? process.env.COMSPEC,
          isWsl: shouldSkipCodexHomeEnvForWindowsShell(daemonShellOverride, cwd),
          wslDistro: codexSelectionTarget.runtime === 'wsl' ? codexSelectionTarget.wslDistro : null,
          agentStatusHooksEnabled: isAgentStatusHooksEnabled(getSettings?.()),
          networkProxySettings: getSettings?.()
        })
        promoteAgentTeamsShimPath(env, requestedAgentTeamsPath)
      }

      const authEnvToDelete = claudeAuth?.stripAuthEnv
        ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
        : undefined
      const spawnOptions: PtySpawnOptions = {
        cols: args.cols,
        rows: args.rows,
        cwd,
        env,
        ...(isMintedSessionId ? { isNewSession: true } : {})
      }
      spawnOptions.envToDelete = mergePtyEnvDeletions(
        mergePtyEnvDeletions(authEnvToDelete, args.envToDelete ?? []),
        isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(env) : []
      )
      if (skipCodexHomeEnv) {
        spawnOptions.envToDelete = mergePtyEnvDeletions(
          spawnOptions.envToDelete,
          CODEX_HOME_ENV_KEYS
        )
      }
      deleteRequestedEnvKeys(env, spawnOptions.envToDelete)
      promoteAgentTeamsShimPath(env, requestedAgentTeamsPath)
      if (args.command !== undefined) {
        spawnOptions.command = args.command
      }
      if (args.commandDelivery !== undefined) {
        spawnOptions.commandDelivery = args.commandDelivery
      }
      if (args.startupCommandDelivery !== undefined) {
        spawnOptions.startupCommandDelivery = args.startupCommandDelivery
      }
      if (args.worktreeId !== undefined) {
        spawnOptions.worktreeId = args.worktreeId
      }
      const hadSessionSizeBeforeAttach =
        effectiveSessionAppId !== undefined ? ptySizes.has(effectiveSessionAppId) : false
      const sessionSizeBeforeAttach =
        effectiveSessionAppId !== undefined ? ptySizes.get(effectiveSessionAppId) : undefined
      if (sessionId !== undefined) {
        spawnOptions.sessionId = sessionId
        ptySizes.set(effectiveSessionAppId ?? sessionId, { cols: args.cols, rows: args.rows })
      }
      const materializedPaneKey = hostSessionBinding
        ? makePaneKey(hostSessionBinding.tabId, hostSessionBinding.leafId)
        : null
      const metadataLeafId =
        typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
      const metadataPaneKey =
        typeof args.tabId === 'string' &&
        isValidTerminalTabId(args.tabId) &&
        args.tabId.length <= 512 &&
        metadataLeafId
          ? makePaneKey(args.tabId, metadataLeafId)
          : null
      const spawnIdentityPaneKey = materializedPaneKey ?? metadataPaneKey
      if (spawnIdentityPaneKey) {
        spawnOptions.paneKey = spawnIdentityPaneKey
      }
      if (typeof args.tabId === 'string' && args.tabId.length > 0 && args.tabId.length <= 512) {
        spawnOptions.tabId = args.tabId
      }
      if (process.platform === 'win32' && !args.connectionId) {
        spawnOptions.shellOverride = terminalRuntimeOptions.shellOverride
        spawnOptions.terminalWindowsWslDistro =
          terminalRuntimeOptions.terminalWindowsWslDistro ?? null
        spawnOptions.terminalWindowsPowerShellImplementation = getSettings
          ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
          : undefined
      }

      const existingPaneSpawn = materializedPaneKey
        ? paneSpawnReservationsByPaneKey.get(materializedPaneKey)
        : undefined
      if (existingPaneSpawn) {
        return await existingPaneSpawn.promise
      }
      const paneSpawnReservation = materializedPaneKey
        ? reservePaneSpawn(materializedPaneKey)
        : null
      let result: PtySpawnResult
      try {
        try {
          if (args.preAllocatedHandle) {
            trustedTerminalHandleEnv.add(args.preAllocatedHandle)
          }
          result = await provider.spawn(spawnOptions)
        } catch (err) {
          const rawMessage = err instanceof Error ? err.message : String(err)
          const spawnError = normalizeNodePtySpawnError(err)
          const isIdentityMismatch =
            isSshPtyIdentityMismatchError(spawnError) || isSshPtyIdentityMismatchError(rawMessage)
          if (effectiveSessionAppId !== undefined) {
            if (isIdentityMismatch && hadSessionSizeBeforeAttach && sessionSizeBeforeAttach) {
              ptySizes.set(effectiveSessionAppId, sessionSizeBeforeAttach)
            } else {
              ptySizes.delete(effectiveSessionAppId)
            }
          }
          if (
            args.connectionId &&
            effectiveSessionRelayId !== undefined &&
            (spawnError.message.includes(SSH_SESSION_EXPIRED_ERROR) ||
              rawMessage.includes(SSH_SESSION_EXPIRED_ERROR))
          ) {
            if (effectiveSessionAppId !== undefined && !isIdentityMismatch) {
              clearProviderPtyState(effectiveSessionAppId)
              deletePtyOwnership(effectiveSessionAppId)
            }
            if (!isIdentityMismatch) {
              store?.markSshRemotePtyLease(args.connectionId, effectiveSessionRelayId, 'expired')
            }
          }
          if (isMintedSessionId && sessionId !== undefined) {
            clearProviderPtyState(sessionId)
          }
          throw spawnError
        } finally {
          if (args.preAllocatedHandle) {
            trustedTerminalHandleEnv.delete(args.preAllocatedHandle)
          }
        }
        ptyOwnership.set(result.id, args.connectionId ?? null)
        // Why: Phase-5 ConPTY DA1 — record the native-Windows-local-PTY
        // determination from the spawn record before any byte reaches the
        // runtime emulator, so its DA1 override exists from byte zero.
        if (
          isNativeWindowsLocalPtySpawn({
            connectionId: args.connectionId,
            cwd: args.cwd,
            shellOverride: daemonShellOverride
          })
        ) {
          markNativeWindowsConptyPty(result.id)
        }
        const relayResultId = getRelayPtyId(args.connectionId, result.id)
        const persistSshLease = (): void => {
          if (!store || !args.connectionId) {
            return
          }
          // Why: workspace-session bindings keep app-facing PTY ids for hydration,
          // while SSH leases keep relay ids for remote lease reconciliation.
          store.upsertSshRemotePtyLease({
            targetId: args.connectionId,
            ptyId: relayResultId,
            ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
            ...(typeof args.tabId === 'string' ? { tabId: args.tabId } : {}),
            ...(typeof args.leafId === 'string' && isTerminalLeafId(args.leafId)
              ? { leafId: args.leafId }
              : {}),
            state: 'attached',
            lastAttachedAt: Date.now()
          })
        }
        if (!hostSessionBinding) {
          persistSshLease()
        }
        ptySizes.set(result.id, { cols: args.cols, rows: args.rows })
        if (effectiveSessionAppId !== undefined && effectiveSessionAppId !== result.id) {
          ptySizes.delete(effectiveSessionAppId)
        }
        if (hostSessionBinding) {
          try {
            hostSessionBinding.store.persistPtyBinding({
              worktreeId: hostSessionBinding.worktreeId,
              tabId: hostSessionBinding.tabId,
              leafId: hostSessionBinding.leafId,
              ptyId: result.id,
              ...(cwd ? { startupCwd: cwd } : {})
            })
          } catch (err) {
            console.error('[pty] failed to persist runtime PTY binding after spawn:', err)
            deletePtyOwnership(result.id)
            if (!result.isReattach) {
              try {
                await provider.shutdown(result.id, { immediate: true })
              } catch (shutdownErr) {
                console.warn('[pty] failed to clean up PTY after persistence failure:', shutdownErr)
              }
              clearProviderPtyState(result.id)
            }
            throw new Error(createTerminalSessionStateSaveFailureMessage())
          }
          persistSshLease()
        }
        if (args.preAllocatedHandle) {
          runtime?.registerPreAllocatedHandleForPty(result.id, args.preAllocatedHandle)
        }
        if (args.worktreeId) {
          runtime?.registerPty(
            result.id,
            args.worktreeId,
            args.connectionId ?? null,
            // Why: thread the validated pane identity so main can back a pending
            // mobile create from this live spawn even if graph-sync stalls (#7587).
            // Bound tabId like the sibling metadataPaneKey/spawnOptions.tabId here.
            typeof args.tabId === 'string' &&
              isValidTerminalTabId(args.tabId) &&
              args.tabId.length <= 512 &&
              metadataLeafId !== null
              ? { tabId: args.tabId, leafId: metadataLeafId }
              : undefined,
            !args.connectionId
              ? shouldSkipCodexHomeEnvForWindowsShell(daemonShellOverride, cwd)
              : undefined
          )
        }
        // Why: arms main's per-PTY Command Code output detector from the launch
        // command (renderer startupCommand parity); banner detection covers
        // PTYs spawned without one.
        runtime?.noteTerminalSpawnCommand?.(result.id, args.command ?? null)
        if (isClaudeLaunch) {
          markClaudePtySpawned(result.id)
        }
        if (args.telemetry) {
          const agentKindParse = agentKindSchema.safeParse(args.telemetry.agent_kind)
          const launchSourceParse = launchSourceSchema.safeParse(args.telemetry.launch_source)
          const requestKindParse = requestKindSchema.safeParse(args.telemetry.request_kind)
          if (agentKindParse.success && launchSourceParse.success && requestKindParse.success) {
            track('agent_started', {
              agent_kind: agentKindParse.data,
              launch_source: launchSourceParse.data,
              request_kind: requestKindParse.data,
              ...getCohortAtEmit()
            })
          }
        }
        // Why: runtime-owned CLI PTYs bypass the renderer `pty:spawn` handler,
        // so record their spawn-time paneKey here too. Synthetic hook titles and
        // paneKey-scoped cache cleanup both depend on this reverse lookup.
        const paneKey = rememberPaneKeyForPty(result.id, env?.ORCA_PANE_KEY)
        if (!args.connectionId) {
          registerPty({
            ptyId: result.id,
            worktreeId: args.worktreeId ?? null,
            sessionId: sessionId ?? null,
            paneKey,
            pid:
              typeof result.pid === 'number' && Number.isFinite(result.pid) && result.pid > 0
                ? result.pid
                : null
          })
        }
        const response = { id: result.id }
        return resolvePaneSpawnReservation(materializedPaneKey, paneSpawnReservation, response)
      } catch (err) {
        // Why: once the reservation is created, any later throw — spawn
        // failure, persist failure, or a post-spawn helper such as
        // registerPty/rememberPaneKeyForPty/track — must settle it. Otherwise
        // it lingers in paneSpawnReservationsByPaneKey and every future spawn
        // for this pane awaits a promise that never resolves. reject is a
        // no-op once the reservation has already resolved.
        rejectPaneSpawnReservation(materializedPaneKey, paneSpawnReservation, err)
        throw err
      }
    },
    write: (ptyId, data) => {
      const provider = getProviderForPty(ptyId)
      try {
        provider.write(ptyId, data)
        return true
      } catch {
        return false
      }
    },
    kill: (ptyId) => {
      let provider: IPtyProvider
      let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
      const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
      connectionId ??= parsedSshId?.connectionId
      try {
        provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
      } catch {
        if (connectionId) {
          // Why: runtime/CLI close can target a detached SSH PTY after its
          // provider was unregistered. Tombstone the lease so reconnect does
          // not revive a terminal the user explicitly closed.
          finishPtyShutdown(ptyId, connectionId, store)
          runtime?.onPtyExit(ptyId, -1)
          rememberSyntheticKillExit(ptyId)
          sendPtyExitToRenderer({ id: ptyId, code: -1 })
          return true
        }
        return false
      }
      // Why: shutdown() is async but the PtyController interface is sync. Defer
      // cleanup until shutdown resolves so transient SSH/daemon failures don't
      // hide a still-running remote process or local daemon session.
      //
      // Same synthetic-exit contract as the renderer pty:kill handler: when the
      // provider emitted its own exit during shutdown, the exit listener already
      // delivered runtime + renderer exits — synthesizing again would double-fire.
      void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
        .then((providerExitObserved) => {
          finishPtyShutdown(ptyId, connectionId, store)
          if (!providerExitObserved) {
            runtime?.onPtyExit(ptyId, -1)
            rememberSyntheticKillExit(ptyId)
            sendPtyExitToRenderer({ id: ptyId, code: -1 })
          }
        })
        .catch((err) => {
          if (isPtyAlreadyGoneError(err)) {
            finishPtyShutdown(ptyId, connectionId, store)
            runtime?.onPtyExit(ptyId, -1)
            rememberSyntheticKillExit(ptyId)
            sendPtyExitToRenderer({ id: ptyId, code: -1 })
            return
          }
          console.warn(
            `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
          )
          // Why: callers of controller.kill must observe a kill→exit pair so
          // runtime tail buffers close and agents stop treating the pane as
          // live. Preserve provider/lease state so a retry can still target
          // the remote PTY if it survived the transient failure.
          runtime?.onPtyExit(ptyId, -1)
        })
      return true
    },
    stopAndWait: async (ptyId, opts) => {
      let provider: IPtyProvider
      let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
      const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
      connectionId ??= parsedSshId?.connectionId
      try {
        provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
      } catch {
        if (connectionId) {
          // Why: an absent SSH provider means there is no live target left to
          // await, but the relay lease must still be tombstoned.
          finishPtyShutdown(ptyId, connectionId, store)
          runtime?.onPtyExit(ptyId, -1)
          rememberSyntheticKillExit(ptyId)
          sendPtyExitToRenderer({ id: ptyId, code: -1 })
          return true
        }
        return false
      }
      let providerExitObserved = false
      try {
        providerExitObserved = await shutdownProviderAndDetectExit(provider, ptyId, {
          immediate: true,
          keepHistory: opts?.keepHistory ?? false
        })
      } catch (err) {
        if (!isPtyAlreadyGoneError(err)) {
          console.warn(
            `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
          )
          return false
        }
      }
      try {
        if (!(await verifyPtyStopped(provider, ptyId, opts))) {
          return false
        }
      } catch (err) {
        console.warn(
          `[pty] Failed to verify PTY ${ptyId} stopped: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        return false
      }
      finishPtyShutdown(ptyId, connectionId, store)
      if (!providerExitObserved) {
        runtime?.onPtyExit(ptyId, -1)
        rememberSyntheticKillExit(ptyId)
        sendPtyExitToRenderer({ id: ptyId, code: -1 })
      }
      return true
    },
    getForegroundProcess: async (ptyId) => {
      try {
        return await getProviderForPty(ptyId).getForegroundProcess(ptyId)
      } catch {
        return null
      }
    },
    confirmForegroundProcess: async (ptyId) => {
      try {
        const provider = getProviderForPty(ptyId)
        // Why: cached foreground evidence cannot resolve a fresh shell conflict.
        return (await provider.confirmForegroundProcess?.(ptyId)) ?? null
      } catch {
        return null
      }
    },
    getCwd: async (ptyId) => {
      try {
        const cwd = await getProviderForPty(ptyId).getCwd(ptyId)
        return cwd || null
      } catch {
        return null
      }
    },
    hasChildProcesses: async (ptyId) => {
      try {
        return await getProviderForPty(ptyId).hasChildProcesses(ptyId)
      } catch {
        return false
      }
    },
    clearBuffer: async (ptyId) => {
      // Why: desktop xterm owns local scrollback, while daemon/SSH providers
      // own their own retained buffers. Clear both surfaces so mobile
      // resubscribe snapshots do not resurrect cleared history.
      mainWindow.webContents.send('pty:clearBuffer:request', { ptyId })
      try {
        await getProviderForPty(ptyId).clearBuffer(ptyId)
      } catch {
        /* best effort: renderer clear still handles local PTYs */
      }
    },
    listProcesses: async () => {
      const providerSessions = await Promise.all([
        localProvider.listProcesses(),
        ...Array.from(sshProviders.values(), (provider) => provider.listProcesses())
      ])
      return providerSessions.flat()
    },
    serializeBuffer: (ptyId, opts) => {
      // Why: mobile xterm must start from the desktop xterm's exact screen
      // state and dimensions before live TUI chunks can render correctly.
      return requestSerializedBuffer(ptyId, opts)
    },
    hasRendererSerializer: (ptyId) => {
      // Why: the runtime needs a synchronous probe so it can decide whether to
      // skip the daemon-snapshot seed (the renderer will hydrate it) or run the
      // seed (no renderer authoritative for this PTY). A registry write happens
      // when the renderer calls registerPtySerializer; we check via the same
      // pendingByPaneKey + ptyId pairing that the cooperation gate uses.
      return rendererSerializerByPtyId.has(ptyId)
    },
    getSize: (ptyId) => ptySizes.get(ptyId) ?? null,
    resize: (ptyId, cols, rows) => {
      try {
        getProviderForPty(ptyId).resize(ptyId, cols, rows)
        ptySizes.set(ptyId, { cols, rows })
        return true
      } catch {
        return false
      }
    }
  })

  // ─── IPC Handlers (thin dispatch layer) ─────────────────────────

  function normalizeSnapshotScrollbackRows(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined
    }
    return Math.max(0, Math.min(50_000, Math.floor(value)))
  }

  ipcMain.handle(
    'pty:getMainBufferSnapshot',
    async (
      _event,
      args: { id?: unknown; opts?: { scrollbackRows?: unknown } }
    ): Promise<{
      data: string
      cols: number
      rows: number
      cwd?: string | null
      lastTitle?: string
      seq?: number
      pendingDeliveryStartSeq?: number
      source?: 'headless' | 'renderer'
      alternateScreen?: boolean
      scrollbackAnsi?: string
      pendingEscapeTailAnsi?: string
    } | null> => {
      if (!runtime || typeof args?.id !== 'string' || args.id.length === 0) {
        return null
      }
      const scrollbackRows = normalizeSnapshotScrollbackRows(args.opts?.scrollbackRows)
      try {
        const runtimeSeqBeforeSnapshot = runtime.getPtyOutputSequence(args.id)
        const providerSnapshotRequired = providerSnapshotRequiredPtys.has(args.id)
        const providerSnapshot = providerSnapshotRequired
          ? await tryGetProviderForPty(args.id)?.getBufferSnapshot?.(args.id, {
              scrollbackRows
            })
          : null
        // Why: after a data gap, main's model contains only the retained tail.
        // Returning it as a full snapshot would silently erase older scrollback.
        if (providerSnapshotRequired && !providerSnapshot) {
          return null
        }
        const snapshot =
          providerSnapshot ??
          (await runtime.serializeHiddenOutputRecoveryBuffer(args.id, {
            scrollbackRows
          }))
        if (!snapshot || typeof snapshot.seq !== 'number') {
          return snapshot
        }
        // Why: sampled after serialize — every byte at or below snapshot.seq
        // that can still reach the renderer sits in this pending queue. The
        // renderer's post-restore dedupe bounds its duplicate window with it;
        // without the bound a stale baseline silently swallows genuinely-new
        // chunks whose seq domain sits below the snapshot counter.
        const pending = pendingData.get(args.id)
        if (pending && typeof pending.startSeq !== 'number') {
          // Why: a seq-less backlog cannot be bounded — stay conservative.
          return snapshot
        }
        return {
          ...snapshot,
          pendingDeliveryStartSeq: Math.min(
            pending?.startSeq ?? (providerSnapshot ? runtimeSeqBeforeSnapshot : snapshot.seq),
            snapshot.seq
          )
        }
      } catch {
        return null
      }
    }
  )

  // Why: with main holding side-effect authority the renderer no longer
  // derives titles from replayed bytes on (re)attach. This title-only replay
  // snapshot restores title state — never historical bells/completions (the
  // no-attention-replay rule, terminal-side-effect-authority.md).
  ipcMain.handle('pty:sideEffectSnapshot', (_event, args: { id: string }) => {
    if (!runtime || typeof args?.id !== 'string' || args.id.length === 0) {
      return null
    }
    return runtime.getTerminalSideEffectSnapshot(args.id)
  })

  installPowerSignalBreadcrumbs()
  ipcMain.handle('pty:getRendererDeliveryDebugSnapshot', (): PtyRendererDeliveryDebugSnapshot => {
    return getPtyRendererDeliveryDebugSnapshot()
  })
  ipcMain.handle('pty:resetRendererDeliveryDebug', (): void => {
    resetPtyRendererDeliveryDebug()
  })

  ipcMain.handle(
    'pty:spawn',
    async (
      _event,
      args: {
        cols: number
        rows: number
        cwd?: string
        // Why: fresh local renderer spawns opt into recovering a saved cwd
        // whose directory was deleted (#7239); reattach/remote callers must
        // keep exact cwd semantics, so the flag alone is not sufficient.
        cwdFallback?: 'worktree'
        env?: Record<string, string>
        envToDelete?: string[]
        command?: string
        commandDelivery?: 'renderer' | 'provider'
        launchConfig?: SleepingAgentLaunchConfig
        launchAgent?: TuiAgent
        startupCommandDelivery?: StartupCommandDelivery
        connectionId?: string | null
        worktreeId?: string
        sessionId?: string
        shellOverride?: string
        projectRuntime?: ProjectExecutionRuntimeResolution
        terminalColorQueryReplies?: {
          foreground?: unknown
          background?: unknown
        }
        // Why: hidden-at-spawn declaration (terminal-query-authority.md
        // §races) — the renderer knows at spawn time that no visible view
        // will consume this PTY's bytes, so main marks it hidden BEFORE the
        // first byte and the gate + model responder own spawn-time queries.
        initiallyHidden?: boolean
        // Why: closes the SIGKILL race documented in INVESTIGATION.md by
        // letting main patch + sync-flush the (worktreeId, tabId, leafId →
        // ptyId) binding before pty:spawn returns. Only the renderer's
        // user-typing-Ctrl+T daemon-host path threads these; mobile/runtime
        // CLI/SSH spawns leave them undefined and the main-side guard
        // short-circuits.
        tabId?: string
        leafId?: string
        // Why: telemetry-plan.md§Agent launch semantics. The renderer
        // threads what Orca was *asked* to launch through this field; main
        // fires `agent_started` only after `provider.spawn` resolves. Loose
        // typing on the IPC boundary because the main-side schema
        // validator is the single enforcement point — `track()` will drop
        // the event if any field is outside its closed enum.
        telemetry?: {
          agent_kind?: unknown
          launch_source?: unknown
          request_kind?: unknown
        }
      }
    ) => {
      const spawnTiming = createPtySpawnTiming()
      const startupPromise = getLocalPtyStartupPromise(args.connectionId)
      if (startupPromise) {
        await startupPromise
      }
      await assertFolderWorkspacePtyPathUsable(args.worktreeId)
      // Why: honor the fallback only for fresh local spawns even if a caller
      // sends the flag — reattach must keep the session's exact cwd and
      // remote/SSH paths cannot probe the local filesystem meaningfully.
      const allowMissingCwdFallback =
        !args.connectionId && !args.sessionId && args.cwdFallback === 'worktree'
      let didFallbackToWorkspaceRootCwd = false
      const cwd = resolvePtySpawnStartupCwd(
        args.worktreeId,
        args.cwd,
        allowMissingCwdFallback
          ? {
              directoryExists: localStartupCwdDirectoryExists,
              onFallbackToWorkspaceRoot: () => {
                didFallbackToWorkspaceRootCwd = true
              }
            }
          : undefined
      )
      const startupCwdFallback =
        didFallbackToWorkspaceRootCwd && cwd ? ({ kind: 'worktree', cwd } as const) : undefined
      spawnTiming.mark('preflight')
      const provider = getProvider(args.connectionId)
      const isClaudeLaunch = !args.connectionId && isClaudeLaunchCommand(args.command)
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      const terminalRuntimeOptions =
        process.platform === 'win32' && !args.connectionId
          ? resolveLocalWindowsTerminalRuntimeOptions({
              requestedShellOverride: args.shellOverride,
              settings: getSettings?.(),
              projectRuntime: args.projectRuntime,
              fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
            })
          : { shellOverride: args.shellOverride, terminalWindowsWslDistro: null }
      const initialShellOverride = terminalRuntimeOptions.shellOverride
      const initialSelectionTarget = getCodexSelectionTargetForPty(
        initialShellOverride,
        cwd,
        terminalRuntimeOptions.terminalWindowsWslDistro ?? null
      )
      const claudeAuth =
        isClaudeLaunch && prepareClaudeAuth ? await prepareClaudeAuth(initialSelectionTarget) : null
      spawnTiming.mark('auth')
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      if (claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
        throw new Error(
          'This Claude launch defines explicit Anthropic auth environment variables. Remove those overrides before using a managed Claude account.'
        )
      }
      // Why: the daemon-backed provider replaces LocalPtyProvider and therefore
      // never runs its buildSpawnEnv closure. We must assemble the same
      // host-local env (OpenCode plugin, agent-hook server, Pi/OMP managed
      // extensions, Codex home, dev CLI overrides, GitHub attribution shims)
      // here so both spawn paths behave identically. buildPtyHostEnv is the
      // shared helper that encapsulates the full set of injections and guards.
      //
      // Safety: skip the entire injection when a remote (SSH) connection is in
      // play. Every injection here is either host-loopback (the agent-hook
      // server binds 127.0.0.1, so shipping its token to an SSH host would
      // leak a loopback secret for no functional benefit) or a path on the
      // local filesystem (OpenCode plugin dir, Pi/OMP extension paths, Codex
      // home, dev CLI bin, attribution shim dir) that would resolve to
      // nothing — or something misleading — on the remote machine.
      const isDaemonHostSpawn =
        !args.connectionId &&
        !(provider instanceof LocalPtyProvider) &&
        !routesFreshSpawnsToLocalProvider(provider)
      // Why: daemon host-env setup needs a stable id BEFORE provider.spawn so
      // provider hooks and legacy Pi overlay cleanup can run in buildPtyHostEnv.
      // DaemonPtyAdapter.doSpawn mints an id the same way when sessionId is
      // absent — lifting the mint here gives pty.ts the id up-front without
      // changing daemon semantics (the daemon still honors opts.sessionId ?? mint()).
      //
      // Note: the sessionId is STABLE across daemon restarts by design —
      // DaemonPtyAdapter.reconcileOnStartup reuses it so that users' live
      // shells survive crashes. Do NOT "simplify" id allocation back to a
      // fresh UUID per spawn; that would orphan reconnectable terminal state.
      // Why: only state for ids we minted in THIS request should be cleared on
      // spawn failure. If the caller supplied args.sessionId it may refer to
      // an existing PTY whose state (OpenCode hooks, legacy Pi overlay cleanup,
      // agent-hook pane caches) we must not clobber on a retry/attach failure.
      const isMintedSessionId = args.sessionId === undefined && isDaemonHostSpawn
      const effectiveSessionId =
        args.sessionId ?? (isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
      const effectiveSessionAppId =
        effectiveSessionId !== undefined
          ? getAppPtyId(args.connectionId, effectiveSessionId)
          : undefined
      const effectiveSessionRelayId =
        effectiveSessionId !== undefined
          ? getRelayPtyId(args.connectionId, effectiveSessionId)
          : undefined
      const startupTerminalColorQueryReplyColors = getStartupTerminalColorQueryReplyColors(args)
      const preSpawnStartupTerminalColorReplyPtyId =
        startupTerminalColorQueryReplyColors && effectiveSessionId !== undefined
          ? (effectiveSessionAppId ?? effectiveSessionId)
          : null
      // Why: the renderer sets pane env for SSH too. Only forward it to the
      // remote when the relay hook path is enabled; otherwise a newer relay
      // could emit statuses this Orca build is not prepared to route.
      const sshSourceEnv = stripRemotePaneEnvWhenHooksDisabled(args.connectionId, args.env)
      const baseEnvWithAuth = claudeAuth
        ? { ...sshSourceEnv, ...claudeAuth.envPatch }
        : sshSourceEnv
      const spawnPaneKey = baseEnvWithAuth?.ORCA_PANE_KEY
      const parsedSpawnPaneKey = parseValidPaneKey(spawnPaneKey)
      const verifiedPaneKey =
        parsedSpawnPaneKey &&
        typeof args.tabId === 'string' &&
        args.tabId === parsedSpawnPaneKey.tabId &&
        args.leafId === parsedSpawnPaneKey.leafId
          ? makePaneKey(parsedSpawnPaneKey.tabId, parsedSpawnPaneKey.leafId)
          : null
      const verifiedLeafId =
        verifiedPaneKey && parsedSpawnPaneKey ? parsedSpawnPaneKey.leafId : null
      const metadataLeafId =
        typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
      const metadataPaneKey =
        typeof args.tabId === 'string' &&
        isValidTerminalTabId(args.tabId) &&
        args.tabId.length <= 512 &&
        metadataLeafId
          ? makePaneKey(args.tabId, metadataLeafId)
          : null
      const legacySpawnPaneKey = verifiedPaneKey ? null : parseLegacyNumericPaneKey(spawnPaneKey)
      const migrationUnsupportedPaneKey =
        legacySpawnPaneKey &&
        typeof args.tabId === 'string' &&
        args.tabId === legacySpawnPaneKey.tabId &&
        typeof args.leafId === 'string' &&
        isTerminalLeafId(args.leafId)
          ? makePaneKey(args.tabId, args.leafId)
          : null
      const stablePaneKey = verifiedPaneKey ?? migrationUnsupportedPaneKey
      let baseEnv = baseEnvWithAuth ? { ...baseEnvWithAuth } : undefined
      const shouldRefreshAgentTeamsEnv =
        !args.connectionId &&
        runtime !== undefined &&
        stablePaneKey !== null &&
        shouldRefreshNativeClaudeAgentTeamsEnv({
          command: args.command,
          launchConfig: args.launchConfig
        })
      let effectiveLaunchConfig = args.launchConfig
      const shouldPreAllocateTerminalHandle =
        runtime !== undefined &&
        ((!(provider instanceof LocalPtyProvider) && !routesFreshSpawnsToLocalProvider(provider)) ||
          shouldRefreshAgentTeamsEnv)
      const preAllocatedHandle = shouldPreAllocateTerminalHandle
        ? runtime.createPreAllocatedTerminalHandle()
        : null
      if (shouldRefreshAgentTeamsEnv && preAllocatedHandle) {
        // Why: native Agent Teams team ids/tokens are process-local. A sleeping
        // record preserves the user's native launch shape, but the team env
        // itself must be regenerated for the new leader PTY.
        const prepared = await runtime.prepareClaudeAgentTeamsLeaderForHandle({
          handle: preAllocatedHandle,
          baseEnv: baseEnv ?? {}
        })
        baseEnv = {
          ...baseEnv,
          ...prepared.env
        }
        if (args.launchConfig) {
          effectiveLaunchConfig = {
            ...args.launchConfig,
            agentEnv: {
              ...args.launchConfig.agentEnv,
              ...prepared.env
            }
          }
        }
      }
      const requestedAgentTeamsPath = baseEnv?.ORCA_AGENT_TEAMS_TEAM_ID ? baseEnv.PATH : undefined
      const agentTeamsEnvToDelete = shouldRefreshAgentTeamsEnv
        ? ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
        : undefined
      if (baseEnv && stablePaneKey) {
        baseEnv.ORCA_PANE_KEY = stablePaneKey
        if (typeof args.tabId === 'string') {
          baseEnv.ORCA_TAB_ID = args.tabId
        } else if (!args.connectionId) {
          delete baseEnv.ORCA_TAB_ID
        }
        if (typeof args.worktreeId === 'string') {
          baseEnv.ORCA_WORKTREE_ID = args.worktreeId
        } else if (!args.connectionId) {
          delete baseEnv.ORCA_WORKTREE_ID
        }
      } else if (baseEnv) {
        // Why: ORCA_PANE_KEY crosses into shells and hook registries. Only the
        // key proven to match this spawn's tab+leaf may leave the IPC boundary.
        delete baseEnv.ORCA_PANE_KEY
        delete baseEnv.ORCA_TAB_ID
        delete baseEnv.ORCA_WORKTREE_ID
        delete baseEnv.ORCA_AGENT_LAUNCH_TOKEN
      }
      const validatedPaneKey = stablePaneKey
      // Why: SSH can strip ORCA_PANE_KEY when remote hooks are disabled; the
      // IPC tab/leaf metadata still names the pane and matches runtime fallback.
      const reservationPaneKey = metadataPaneKey ?? validatedPaneKey
      const validatedLeafId = verifiedLeafId ?? metadataLeafId
      let env: Record<string, string> | undefined = baseEnv
      const effectiveShellOverride = terminalRuntimeOptions.shellOverride
      const codexSelectionTarget = getCodexSelectionTargetForPty(
        effectiveShellOverride,
        cwd,
        terminalRuntimeOptions.terminalWindowsWslDistro ?? null
      )
      const selectedCodexHomePath = isDaemonHostSpawn
        ? getCompatibleSelectedCodexHomePath(
            codexSelectionTarget,
            getSelectedCodexHomePath?.(codexSelectionTarget) ?? null
          )
        : null
      const skipCodexHomeEnv =
        isDaemonHostSpawn &&
        shouldSkipCodexHomeEnvForWindowsShell(effectiveShellOverride, cwd) &&
        !selectedCodexHomePath
      if (isDaemonHostSpawn) {
        if (effectiveSessionId === undefined) {
          // Should be unreachable: the expression above returns a string when
          // isDaemonHostSpawn is true. Defense-in-depth in case future edits
          // break this invariant.
          throw new Error('Invariant violation: daemon spawn without sessionId')
        }
        const sessionIdForEnv = effectiveSessionId
        // Why: this id still reaches filesystem side-effects for provider
        // hook state and stale pre-migration Pi overlay cleanup; reject
        // traversal/path separators before a crafted IPC payload can escape
        // the expected roots.
        if (!isSafePtySessionId(sessionIdForEnv, app.getPath('userData'))) {
          throw new Error('Invalid PTY session id')
        }
        // Why: clone before mutating so we don't leak injections back into
        // args.env (which the renderer may reuse for other IPC calls).
        env = { ...baseEnv }
        try {
          buildPtyHostEnv(sessionIdForEnv, env, {
            isPackaged: app.isPackaged,
            userDataPath: app.getPath('userData'),
            selectedCodexHomePath,
            skipCodexHomeEnv,
            githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false,
            launchCommand: args.command,
            shellPath: effectiveShellOverride ?? process.env.COMSPEC,
            isWsl: shouldSkipCodexHomeEnvForWindowsShell(effectiveShellOverride, cwd),
            wslDistro:
              codexSelectionTarget.runtime === 'wsl' ? codexSelectionTarget.wslDistro : null,
            agentStatusHooksEnabled: isAgentStatusHooksEnabled(getSettings?.()),
            networkProxySettings: getSettings?.()
          })
          promoteAgentTeamsShimPath(env, requestedAgentTeamsPath)
        } catch (err) {
          // Why: buildPtyHostEnv has filesystem side-effects (Pi/OMP managed
          // extension installation). If it throws before we reach provider.spawn,
          // clear per-PTY state so the next attempt starts clean.
          //
          // Only sweep state for ids we MINTED in this request — caller-
          // supplied ids may refer to existing PTYs whose overlay/hook state
          // must not be clobbered by a transient overlay-mkdir failure on a
          // retry/attach path.
          if (isMintedSessionId) {
            clearProviderPtyState(sessionIdForEnv)
          }
          throw err
        }
      }
      spawnTiming.mark('host_env')
      const spawnEnv = preAllocatedHandle
        ? { ...env, ORCA_TERMINAL_HANDLE: preAllocatedHandle }
        : env
      const envToDelete = claudeAuth?.stripAuthEnv
        ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
        : undefined
      const combinedEnvToDelete = mergePtyEnvDeletions(
        mergePtyEnvDeletions(
          mergePtyEnvDeletions(
            mergePtyEnvDeletions(envToDelete, args.envToDelete ?? []),
            agentTeamsEnvToDelete ?? []
          ),
          isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(spawnEnv) : []
        ),
        skipCodexHomeEnv ? CODEX_HOME_ENV_KEYS : []
      )
      deleteRequestedEnvKeys(spawnEnv, combinedEnvToDelete)
      promoteAgentTeamsShimPath(spawnEnv, requestedAgentTeamsPath)
      const spawnOptions: PtySpawnOptions = {
        cols: args.cols,
        rows: args.rows,
        cwd,
        env: spawnEnv,
        ...(isMintedSessionId ? { isNewSession: true } : {})
      }
      if (combinedEnvToDelete) {
        spawnOptions.envToDelete = combinedEnvToDelete
      }
      if (args.command !== undefined) {
        spawnOptions.command = args.command
      }
      if (args.commandDelivery !== undefined) {
        spawnOptions.commandDelivery = args.commandDelivery
      }
      if (args.startupCommandDelivery !== undefined) {
        spawnOptions.startupCommandDelivery = args.startupCommandDelivery
      }
      if (isTuiAgent(args.launchAgent)) {
        spawnOptions.launchAgent = args.launchAgent
      }
      if (args.worktreeId !== undefined) {
        spawnOptions.worktreeId = args.worktreeId
      }
      if (reservationPaneKey) {
        spawnOptions.paneKey = reservationPaneKey
      }
      if (typeof args.tabId === 'string' && args.tabId.length > 0 && args.tabId.length <= 512) {
        spawnOptions.tabId = args.tabId
      }
      if (effectiveSessionId !== undefined) {
        spawnOptions.sessionId = effectiveSessionId
      }
      // Why: on Windows, fall back to the persisted default-shell setting
      // when the renderer didn't send a per-tab override. Without this, the
      // daemon path ignores the user's "Default Shell" preference entirely —
      // it just calls resolvePtyShellPath(env) which reads COMSPEC (cmd.exe)
      // or falls back to PowerShell. The LocalPtyProvider already consults
      // getWindowsShell(); this mirrors that on the daemon path so users who
      // set WSL as default actually get WSL when pressing Ctrl+T.
      if (effectiveShellOverride !== undefined) {
        spawnOptions.shellOverride = effectiveShellOverride
      }
      const hadSessionSizeBeforeAttach =
        effectiveSessionAppId !== undefined ? ptySizes.has(effectiveSessionAppId) : false
      const sessionSizeBeforeAttach =
        effectiveSessionAppId !== undefined ? ptySizes.get(effectiveSessionAppId) : undefined
      if (effectiveSessionId !== undefined) {
        // Why: daemon PTYs can emit prompt/startup bytes before spawn()
        // resolves. Runtime headless snapshots need the real pane geometry
        // for those early bytes; otherwise they default to 80x24 and wrap TUIs.
        ptySizes.set(effectiveSessionAppId ?? effectiveSessionId, {
          cols: args.cols,
          rows: args.rows
        })
      }
      if (process.platform === 'win32' && !args.connectionId) {
        // Why: the renderer only models PowerShell as one shell family. Thread
        // the persisted implementation choice through spawnOptions so both the
        // in-process and daemon-backed PTY paths can resolve the same effective
        // executable without inventing a fourth top-level shell.
        spawnOptions.terminalWindowsWslDistro =
          terminalRuntimeOptions.terminalWindowsWslDistro ?? null
        spawnOptions.terminalWindowsPowerShellImplementation = getSettings
          ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
          : undefined
      }
      const existingPaneSpawn = reservationPaneKey
        ? paneSpawnReservationsByPaneKey.get(reservationPaneKey)
        : undefined
      if (existingPaneSpawn) {
        return await existingPaneSpawn.promise
      }
      const paneSpawnReservation = reservationPaneKey ? reservePaneSpawn(reservationPaneKey) : null
      const initiallyHidden = args.initiallyHidden === true
      // Why pre-spawn for daemon-host sessions (id minted up front): daemon
      // PTYs can emit prompt bytes before spawn() resolves, and the hidden
      // mark must beat the first byte so the gate + model responder own
      // spawn-time queries (terminal-query-authority.md §races). Other
      // providers cannot emit until spawn resolves; the post-spawn mark
      // below is byte-zero-safe for them.
      const preSpawnHiddenMarkId =
        initiallyHidden && isDaemonHostSpawn && effectiveSessionAppId !== undefined
          ? effectiveSessionAppId
          : null
      if (preSpawnHiddenMarkId !== null) {
        markHiddenRendererPty(preSpawnHiddenMarkId)
      }
      let result: PtySpawnResult
      try {
        try {
          if (preAllocatedHandle) {
            trustedTerminalHandleEnv.add(preAllocatedHandle)
          }
          if (preSpawnStartupTerminalColorReplyPtyId && startupTerminalColorQueryReplyColors) {
            // Why: Codex probes OSC 10/11 with a 100 ms timeout and daemon PTYs
            // can emit that query before spawn() resolves to the renderer.
            registerStartupTerminalColorQueryReplies(
              preSpawnStartupTerminalColorReplyPtyId,
              startupTerminalColorQueryReplyColors
            )
          }
          spawnTiming.mark('options')
          result = await provider.spawn(spawnOptions)
          spawnTiming.mark('provider_spawn')
        } catch (err) {
          // Why: a failed spawn must not leave a stale hidden mark on a session
          // id a later visible attach may reuse.
          if (preSpawnHiddenMarkId !== null) {
            unmarkHiddenRendererPty(preSpawnHiddenMarkId)
          }
          const rawMessage = err instanceof Error ? err.message : String(err)
          const spawnError = normalizeNodePtySpawnError(err)
          const isIdentityMismatch =
            isSshPtyIdentityMismatchError(spawnError) || isSshPtyIdentityMismatchError(rawMessage)
          if (preSpawnStartupTerminalColorReplyPtyId) {
            clearStartupTerminalColorQueryReplies(preSpawnStartupTerminalColorReplyPtyId)
          }
          if (effectiveSessionAppId !== undefined) {
            if (isIdentityMismatch && hadSessionSizeBeforeAttach && sessionSizeBeforeAttach) {
              ptySizes.set(effectiveSessionAppId, sessionSizeBeforeAttach)
            } else {
              ptySizes.delete(effectiveSessionAppId)
            }
          }
          if (
            args.connectionId &&
            effectiveSessionRelayId !== undefined &&
            (spawnError.message.includes(SSH_SESSION_EXPIRED_ERROR) ||
              rawMessage.includes(SSH_SESSION_EXPIRED_ERROR))
          ) {
            // Why: expired remote reattach means the relay has already dropped
            // the backing PTY. Clear the durable lease so later session writes
            // cannot restore the stale pane binding.
            if (effectiveSessionAppId !== undefined && !isIdentityMismatch) {
              clearProviderPtyState(effectiveSessionAppId)
              deletePtyOwnership(effectiveSessionAppId)
            }
            if (!isIdentityMismatch) {
              store?.markSshRemotePtyLease(args.connectionId, effectiveSessionRelayId, 'expired')
            }
          }
          // Why: if buildPtyHostEnv materialized provider state for this minted
          // id but provider.spawn failed, that state would otherwise leak.
          if (isMintedSessionId && effectiveSessionId !== undefined) {
            clearProviderPtyState(effectiveSessionId)
          }
          // Why: telemetry-plan.md§agent_error — when the renderer threaded
          // agent_kind through args.telemetry, attribute the error to that agent.
          // Otherwise fall back to sniffing the command for `claude` (the one
          // agent the main process can identify on its own via the existing
          // `isClaudeLaunchCommand` regex used for auth gating). Bare-shell
          // catches and unknown-agent catches without renderer telemetry remain
          // unattributed. The event still emits with a classified `error_class`;
          // raw error messages are dropped at the telemetry validator boundary.
          const rendererAgentKindParse =
            args.telemetry?.agent_kind !== undefined
              ? agentKindSchema.safeParse(args.telemetry.agent_kind)
              : null
          const errorAgentKind = rendererAgentKindParse?.success
            ? rendererAgentKindParse.data
            : isClaudeLaunch
              ? ('claude-code' as const)
              : null
          if (errorAgentKind) {
            const classified = classifyError(spawnError)
            track('agent_error', {
              agent_kind: errorAgentKind,
              error_class: classified.error_class,
              ...getCohortAtEmit()
            })
          }
          throw spawnError
        } finally {
          if (preAllocatedHandle) {
            trustedTerminalHandleEnv.delete(preAllocatedHandle)
          }
        }
        spawnTiming.log(result.id, {
          daemon: isDaemonHostSpawn,
          reattach: result.isReattach ?? false
        })
        ptyOwnership.set(result.id, args.connectionId ?? null)
        if (initiallyHidden) {
          // Why marked synchronously before any await below: local/SSH provider
          // data events dispatch on later tasks, so this is still ahead of the
          // first byte's delivery decision. Idempotent for daemon hosts already
          // marked pre-spawn; the renderer's first visibility sync re-marks or
          // unmarks (emitting the restore marker) through the Phase-4 path.
          markHiddenRendererPty(result.id)
          if (preSpawnHiddenMarkId !== null && preSpawnHiddenMarkId !== result.id) {
            // Defense: never strand a mark on an id the provider renamed.
            unmarkHiddenRendererPty(preSpawnHiddenMarkId)
          }
          // Why after ptyOwnership.set: the provider lookup routes by
          // ownership, and a hidden-spawned agent should be paceable from its
          // first flood, not from its first visibility transition.
          syncPtyBackgroundedDelivery(result.id, 'spawn')
        }
        // Why: Phase-5 ConPTY DA1 — record the native-Windows-local-PTY
        // determination from the spawn record before the headless seed below,
        // so the runtime emulator's DA1 override exists from byte zero.
        if (
          isNativeWindowsLocalPtySpawn({
            connectionId: args.connectionId,
            cwd: args.cwd,
            shellOverride: effectiveShellOverride
          })
        ) {
          markNativeWindowsConptyPty(result.id)
        }
        if (startupTerminalColorQueryReplyColors) {
          if (result.isReattach) {
            if (preSpawnStartupTerminalColorReplyPtyId) {
              clearStartupTerminalColorQueryReplies(preSpawnStartupTerminalColorReplyPtyId)
            }
          } else if (preSpawnStartupTerminalColorReplyPtyId) {
            moveStartupTerminalColorQueryReplies(preSpawnStartupTerminalColorReplyPtyId, result.id)
          } else {
            registerStartupTerminalColorQueryReplies(
              result.id,
              startupTerminalColorQueryReplyColors
            )
          }
        }
        const relayResultId = getRelayPtyId(args.connectionId, result.id)
        if (store && args.connectionId) {
          // Why: remote PTYs live in the SSH relay grace window after Orca
          // detaches. Persist their IDs immediately so reconnect can reattach
          // instead of treating the tab as a fresh shell.
          store.upsertSshRemotePtyLease({
            targetId: args.connectionId,
            ptyId: relayResultId,
            ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
            ...(typeof args.tabId === 'string' ? { tabId: args.tabId } : {}),
            ...(validatedLeafId ? { leafId: validatedLeafId } : {}),
            state: 'attached',
            lastAttachedAt: Date.now()
          })
        }
        if (preAllocatedHandle) {
          runtime?.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
        }
        ptySizes.set(result.id, { cols: args.cols, rows: args.rows })
        // Why: closes the SIGKILL-between-spawn-and-persist race (Issue #217)
        // for local daemon PTYs and the equivalent remote-relay race for SSH.
        // The renderer's debounced session writer runs in parallel for every
        // other field; patch the load-bearing (tab.ptyId, ptyIdsByLeafId)
        // binding synchronously so a force-quit in the ~450 ms debounce window
        // cannot orphan either daemon history or a remote relay PTY lease.
        if (
          (isDaemonHostSpawn || args.connectionId) &&
          store &&
          typeof args.worktreeId === 'string' &&
          typeof args.tabId === 'string' &&
          validatedLeafId !== null
        ) {
          try {
            store.persistPtyBinding({
              worktreeId: args.worktreeId,
              tabId: args.tabId,
              leafId: validatedLeafId,
              ptyId: result.id,
              ...(cwd ? { startupCwd: cwd } : {})
            })
          } catch (err) {
            console.error('[pty] failed to persist PTY binding after spawn:', err)
            if (!result.isReattach) {
              try {
                await provider.shutdown(result.id, { immediate: true })
              } catch (shutdownErr) {
                console.warn('[pty] failed to clean up PTY after persistence failure:', shutdownErr)
              }
              clearProviderPtyState(result.id)
              deletePtyOwnership(result.id)
            }
            if (!result.isReattach && args.connectionId && store) {
              store.removeSshRemotePtyLease(args.connectionId, relayResultId)
            }
            throw new Error(createTerminalSessionStateSaveFailureMessage())
          }
        }
        // Why: pre-signal cooperation gate — when the renderer has declared it
        // will own the serializer for this paneKey, suppress the daemon-snapshot
        // seed so the renderer's hydration path (maybeHydrateHeadlessFromRenderer)
        // is the sole authority. The pre-signal is keyed on paneKey because at
        // spawn time the renderer doesn't yet know the new ptyId. See
        // docs/mobile-prefer-renderer-scrollback.md.
        const rendererPreSignaled = validatedPaneKey
          ? pendingByPaneKey.has(validatedPaneKey)
          : false
        const rendererAlreadyRegistered = rendererSerializerByPtyId.has(result.id)
        // Why: capture the pending gen at spawn time so teardown for THIS PTY
        // only settles its own generation. A remount that replaces the entry
        // with a new gen must not be stomped by the old PTY's teardown.
        if (validatedPaneKey && rendererPreSignaled) {
          const pending = pendingByPaneKey.get(validatedPaneKey)
          if (pending) {
            ptyPendingGenByPtyId.set(result.id, pending.gen)
          }
        }

        // Why: hydrate the runtime's headless emulator with the adapter's
        // restore data BEFORE registerPty so any live PTY data that arrives
        // concurrently lands on top of the seed instead of replacing it. Mobile
        // subscribers then see the same scrollback the desktop xterm received
        // via coldRestore/snapshot. Without this, mobile snapshots after a
        // daemon-restored attach contain only bytes emitted since the relaunch
        // and the prior agent output silently disappears.
        //
        // Skip when the renderer is or will be authoritative for this PTY:
        // its hydration path will seed the emulator from xterm's live buffer,
        // which is richer than the daemon snapshot.
        if (runtime && !rendererPreSignaled && !rendererAlreadyRegistered) {
          const seedSize =
            typeof result.snapshotCols === 'number' && typeof result.snapshotRows === 'number'
              ? { cols: result.snapshotCols, rows: result.snapshotRows }
              : undefined
          if (typeof result.snapshot === 'string' && result.snapshot.length > 0) {
            // Why kitty flags ride seed metadata: the snapshot string omits
            // them by design (renderer kitty reset stays authoritative), but
            // the re-seeded emulator must answer hidden `CSI ? u` with the
            // flags the still-running app pushed (terminal-query-authority.md).
            runtime.seedHeadlessTerminal(
              result.id,
              result.snapshot,
              seedSize,
              typeof result.snapshotKittyKeyboardFlags === 'number'
                ? { kittyKeyboardFlags: result.snapshotKittyKeyboardFlags }
                : {}
            )
          } else if (
            result.coldRestore &&
            typeof result.coldRestore.scrollback === 'string' &&
            result.coldRestore.scrollback.length > 0
          ) {
            runtime.seedHeadlessTerminal(result.id, result.coldRestore.scrollback, seedSize, {
              cwd: result.coldRestore.cwd,
              oscLinks: result.coldRestore.oscLinks
            })
          }
        }
        if (
          typeof args.worktreeId === 'string' &&
          args.worktreeId.length > 0 &&
          args.worktreeId.length <= 512
        ) {
          runtime?.registerPty(
            result.id,
            args.worktreeId,
            args.connectionId ?? null,
            // Why: pass the validated pane identity so a mobile create waiting on
            // this renderer tab can publish its surface main-side when graph-sync
            // is throttled, instead of destroying the live PTY (#7587). Bound the
            // untrusted tabId like the sibling metadataPaneKey/spawnOptions.tabId.
            typeof args.tabId === 'string' &&
              isValidTerminalTabId(args.tabId) &&
              args.tabId.length <= 512 &&
              metadataLeafId !== null
              ? { tabId: args.tabId, leafId: metadataLeafId }
              : undefined,
            !args.connectionId
              ? shouldSkipCodexHomeEnvForWindowsShell(effectiveShellOverride, cwd)
              : undefined
          )
        }
        // Why: arms main's per-PTY Command Code output detector from the launch
        // command (renderer startupCommand parity); banner detection covers
        // PTYs spawned without one.
        runtime?.noteTerminalSpawnCommand?.(
          result.id,
          typeof args.command === 'string' ? args.command : null
        )
        if (isClaudeLaunch) {
          markClaudePtySpawned(result.id)
        }
        // Why: renderer sets ORCA_PANE_KEY in `args.env` for every pane-owned
        // spawn (see pty-connection.ts). Recording the mapping here lets
        // clearProviderPtyState clear the agent-hooks server's per-paneKey
        // caches when the PTY exits.
        // Why: args.env arrives as untrusted JSON over IPC — the static
        // Record<string, string> type is not actually enforced at the boundary.
        // Narrow to a bounded string so malformed or oversized values cannot
        // pollute ptyPaneKey or the downstream clearPaneState call.
        const rememberedPaneKey = validatedPaneKey
          ? rememberPaneKeyForPty(result.id, validatedPaneKey)
          : null
        if (legacySpawnPaneKey && migrationUnsupportedPaneKey) {
          agentHookServer.registerPaneKeyAlias(
            legacySpawnPaneKey.paneKey,
            migrationUnsupportedPaneKey,
            result.id
          )
          clearMigrationUnsupportedPtysForPaneKey(migrationUnsupportedPaneKey)
        } else if (validatedPaneKey) {
          if (!result.isReattach) {
            clearMigrationUnsupportedPtysForPaneKey(validatedPaneKey)
          }
        }
        // Why: register local PTYs (connectionId falsy) with the memory
        // collector so it can walk each PTY's process subtree and attribute
        // memory back to its worktree. SSH PTYs execute remotely and their
        // process tree is not visible to our local `ps`, so we skip them.
        if (!args.connectionId) {
          // Why: providers publish the OS pid on the spawn result (both
          // LocalPtyProvider and DaemonPtyAdapter). Recording it once here keeps
          // the memory module from reaching back into ipc/pty on a hot path, and
          // works uniformly whether the PTY is hosted in-process or by the
          // daemon subprocess.
          const spawnedPid = result.pid ?? null
          // Why: args.worktreeId and args.sessionId arrive as untrusted IPC
          // payload strings — the static type is not enforced at the boundary.
          // Narrow them to bounded strings here to match the paneKey defense
          // above so malformed or oversized values cannot pollute registerPty's
          // maps or downstream memory-attribution lookups.
          registerPty({
            ptyId: result.id,
            worktreeId:
              typeof args.worktreeId === 'string' &&
              args.worktreeId.length > 0 &&
              args.worktreeId.length <= 512
                ? args.worktreeId
                : null,
            sessionId:
              typeof args.sessionId === 'string' &&
              args.sessionId.length > 0 &&
              args.sessionId.length <= 256
                ? args.sessionId
                : null,
            paneKey: rememberedPaneKey,
            pid:
              typeof spawnedPid === 'number' && Number.isFinite(spawnedPid) && spawnedPid > 0
                ? spawnedPid
                : null
          })
        }
        // Why: telemetry-plan.md§Agent launch semantics — fire `agent_started`
        // only after `provider.spawn` resolved. The renderer threads
        // `args.telemetry` through the spawn IPC for every launch we want to
        // attribute; bare-shell tabs (no agent) leave the field undefined and
        // do not produce an event. Each field is parsed against its closed
        // enum here so a malformed renderer payload (or a spoofed IPC) does
        // not poison the event — `safeParse` failure drops that field, and
        // if any required field is missing we skip the event entirely. The
        // main-side `track()` validator re-runs the schema on the full
        // payload as a second defense-in-depth check.
        if (args.telemetry) {
          const agentKindParse = agentKindSchema.safeParse(args.telemetry.agent_kind)
          const launchSourceParse = launchSourceSchema.safeParse(args.telemetry.launch_source)
          const requestKindParse = requestKindSchema.safeParse(args.telemetry.request_kind)
          if (agentKindParse.success && launchSourceParse.success && requestKindParse.success) {
            track('agent_started', {
              agent_kind: agentKindParse.data,
              launch_source: launchSourceParse.data,
              request_kind: requestKindParse.data,
              ...getCohortAtEmit()
            })
          }
        }
        const response = {
          ...result,
          ...(!result.isReattach && effectiveLaunchConfig
            ? { launchConfig: effectiveLaunchConfig }
            : {}),
          // Why: a daemon-retry race can surface isReattach even for a minted
          // session id, and a reattach must never claim its cwd was remapped.
          ...(startupCwdFallback && !result.isReattach ? { startupCwdFallback } : {})
        }
        return resolvePaneSpawnReservation(reservationPaneKey, paneSpawnReservation, response)
      } catch (err) {
        // Why: once the reservation is created, any later throw —
        // spawn failure, persist failure, or a post-spawn helper such as
        // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
        // it lingers in paneSpawnReservationsByPaneKey and every future spawn
        // for this pane awaits a promise that never resolves. reject is a
        // no-op once the reservation has already resolved.
        rejectPaneSpawnReservation(reservationPaneKey, paneSpawnReservation, err)
        throw err
      }
    }
  )

  const writePtyProviderInputWithinLimit = (
    provider: IPtyProvider,
    id: string,
    data: string
  ): boolean | Promise<boolean> => {
    const chunks = iterateTerminalInputChunks(data)
    const first = chunks.next()
    if (first.done) {
      provider.write(id, data)
      return true
    }
    const second = chunks.next()
    if (second.done) {
      provider.write(id, first.value)
      return true
    }
    return writePtyProviderInputChunks(provider, id, chunks, first.value, second.value)
  }

  const writePtyProviderInput = (
    provider: IPtyProvider,
    id: string,
    data: string
  ): boolean | Promise<boolean> => {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge ? false : writePtyProviderInputWithinLimit(provider, id, data)
      }
      return tooLarge
        .then((result) => (result ? false : writePtyProviderInputWithinLimit(provider, id, data)))
        .catch(() => false)
    } catch {
      return false
    }
  }

  const writePtyProviderInputChunks = async (
    provider: IPtyProvider,
    id: string,
    chunks: Iterator<string>,
    firstChunk: string,
    secondChunk: string
  ): Promise<boolean> => {
    try {
      let chunk: IteratorResult<string> = { done: false, value: firstChunk }
      let nextChunk: IteratorResult<string> = { done: false, value: secondChunk }
      while (!chunk.done) {
        provider.write(id, chunk.value)
        if (!nextChunk.done) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        chunk = nextChunk
        nextChunk = chunks.next()
      }
      return true
    } catch {
      return false
    }
  }

  type PtyWritePayload = { id: string; data: string }
  type PtyViewportClaimPayload = { id: string; cols: number; rows: number }

  const isPtyWritePayload = (value: unknown): value is PtyWritePayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { data?: unknown }).data === 'string'

  const isPtyViewportClaimPayload = (value: unknown): value is PtyViewportClaimPayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { cols?: unknown }).cols === 'number' &&
    Number.isFinite((value as { cols: number }).cols) &&
    typeof (value as { rows?: unknown }).rows === 'number' &&
    Number.isFinite((value as { rows: number }).rows) &&
    (value as { cols: number }).cols > 0 &&
    (value as { rows: number }).rows > 0

  const isPtyWriteEventFromMainWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    mainWebContents: WebContents
  ): boolean =>
    event.sender === mainWebContents &&
    !mainWindow.isDestroyed() &&
    !(typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed())

  const writePtyInput = (args: PtyWritePayload): boolean | Promise<boolean> => {
    // Why: defense-in-depth for the mobile-presence lock. The renderer's
    // xterm.onData guard already drops desktop keystrokes when mobile is
    // driving, but a stale view between the main-side state flip and the
    // IPC arriving in the renderer can let one keystroke slip through.
    // This server-side check catches it. See
    // docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
    if (!provider) {
      return false
    }
    try {
      const now = performance.now()
      lastInputAtByPty.set(args.id, now)
      interactiveOutputCharsByPty.set(args.id, 0)
      if (visibleRendererPtys.has(args.id)) {
        clearHiddenRendererResizeOutput(args.id)
      }
      return writePtyProviderInput(provider, args.id, args.data)
    } catch {
      return false
    }
  }

  const writePtyInputAccepted = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    // Why: the acknowledgement is used to infer Ctrl+C/Escape actually reached
    // the local PTY. SSH providers are fire-and-forget relay notifications, so
    // they cannot truthfully acknowledge until the relay protocol grows a write
    // request/response.
    if (ptyOwnership.get(args.id) !== null) {
      return false
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty?.(args.id)) {
      return false
    }
    try {
      const now = performance.now()
      lastInputAtByPty.set(args.id, now)
      interactiveOutputCharsByPty.set(args.id, 0)
      if (visibleRendererPtys.has(args.id)) {
        clearHiddenRendererResizeOutput(args.id)
      }
      return writePtyProviderInput(provider, args.id, args.data)
    } catch {
      return false
    }
  }

  const hostViewportClaimTails = new Map<string, Promise<boolean>>()

  ipcMain.on('pty:write', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents) || !isPtyWritePayload(args)) {
      return
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    if (claimTail) {
      void claimTail.then((claimed) => (claimed ? writePtyInput(args) : false))
      return
    }
    writePtyInput(args)
  })
  ipcMain.handle('pty:writeAccepted', (event, args: unknown): boolean | Promise<boolean> => {
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents) || !isPtyWritePayload(args)) {
      return false
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    return claimTail
      ? claimTail.then((claimed) => (claimed ? writePtyInputAccepted(args) : false))
      : writePtyInputAccepted(args)
  })

  ipcMain.removeAllListeners('pty:claimViewport')
  ipcMain.on('pty:claimViewport', (event, args: unknown) => {
    if (
      !isPtyWriteEventFromMainWindow(event, mainWindow.webContents) ||
      !runtime ||
      !isPtyViewportClaimPayload(args)
    ) {
      return
    }
    const prior = hostViewportClaimTails.get(args.id)
    // Why: two panes can mirror one PTY. Never let a later no-op claim replace
    // the in-flight resize that the following host input must await.
    const claim = (
      prior
        ? prior.then(
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows),
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
          )
        : runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
    ).catch(() => false)
    hostViewportClaimTails.set(args.id, claim)
    void claim.then(() => {
      if (hostViewportClaimTails.get(args.id) === claim) {
        hostViewportClaimTails.delete(args.id)
      }
    })
  })

  // Why: resize is fire-and-forget — the renderer doesn't need a reply.
  // Using ipcMain.on (not .handle) halves IPC traffic by avoiding the
  // empty acknowledgement message back to the renderer.
  ipcMain.removeAllListeners('pty:resize')
  ipcMain.on('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    // Why: after a desktop-fit override change, the desktop renderer's
    // re-render cascade runs safeFit on ALL panes (not just the affected
    // one). Background-tab panes get measured at full-width (214) instead
    // of their correct split width. Suppressing ALL pty:resize during
    // this window prevents the cascade from corrupting PTY dimensions.
    if (runtime?.isResizeSuppressed()) {
      return
    }
    // Why: presence-lock defense-in-depth. While a phone OR a remote desktop
    // viewer drives the PTY width, the host's own desktop-side resizes
    // (auto-fit on window resize, split drag, tab reveal, "+"-new-tab
    // re-render) must not reach the PTY — otherwise they overwrite the remote
    // viewer's grid and its alt-screen TUI garbles ("porridge"). The renderer
    // guard checks the driver state too, but this is the load-bearing layer
    // because the renderer mirror lags by one IPC hop. Note: BOTH guards apply
    // — isResizeSuppressed handles the safeFit cascade after take-back; this
    // driver check handles the ongoing locked state. See
    // docs/mobile-presence-lock.md.
    const mobileOwnsResize = runtime?.getDriver(args.id).kind === 'mobile'
    const remoteDesktopOwnsResize = runtime?.isRemoteDesktopResizeDriven?.(args.id) === true
    if (mobileOwnsResize || remoteDesktopOwnsResize) {
      if (remoteDesktopOwnsResize) {
        runtime?.recordRemoteDesktopHostReclaimTarget(args.id, args.cols, args.rows)
      }
      return
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider) {
      return
    }
    const markedHiddenResizeOutput = rendererPtyIsKnownHidden(args.id)
    if (markedHiddenResizeOutput) {
      // Why: alternate-screen TUIs repaint on SIGWINCH. If that hidden repaint
      // is read after the user switches back, it must not masquerade as live
      // foreground output and overwrite the correctly-sized screen.
      pendingHiddenRendererResizeOutputPtys.add(args.id)
      deliveredHiddenRendererResizeOutputPtys.delete(args.id)
    } else if (visibleRendererPtys.has(args.id)) {
      // Why: after the stale hidden-resize repaint has been observed, the
      // renderer's visible resize pulse owns the next repaint.
      clearDeliveredHiddenRendererResizeOutput(args.id)
    }
    try {
      provider.resize(args.id, args.cols, args.rows)
    } catch {
      if (markedHiddenResizeOutput) {
        pendingHiddenRendererResizeOutputPtys.delete(args.id)
      }
      return
    }
    ptySizes.set(args.id, { cols: args.cols, rows: args.rows })
    runtime?.onExternalPtyResize(args.id, args.cols, args.rows)
  })

  // Why: pty:reportGeometry is a measurement-only sibling of pty:resize.
  // pty:resize means "I want the PTY at this size" (a write/intent — gated
  // by mobile-driver and cascade suppress). pty:reportGeometry means "the
  // desktop pane I'm rendering currently measures this many cells" (a
  // read/observation). Mobile-fit hold needs the latter even while the
  // former is intentionally blocked: when a previously-hidden desktop
  // tab becomes visible while a phone is driving, the server has no way
  // to learn the real desktop dims, and resolveDesktopRestoreTarget
  // returns the stale spawn default (e.g. 80×24) on Take Back. Splitting
  // the channels keeps each guard simple — pty:resize keeps its mobile-
  // driver gate; pty:reportGeometry never resizes the PTY, only refreshes
  // the restore-target cache. See docs/mobile-fit-hold.md.
  ipcMain.removeAllListeners('pty:reportGeometry')
  ipcMain.on('pty:reportGeometry', (_event, args: { id: string; cols: number; rows: number }) => {
    runtime?.recordRendererGeometry(args.id, args.cols, args.rows)
  })

  // Why: fire-and-forget — clears the DaemonPtyAdapter's sticky cold restore
  // cache after the renderer has consumed the data. No-op for non-daemon providers.
  ipcMain.on('pty:ackColdRestore', (_event, args: { id: string }) => {
    const provider = tryGetProviderForPty(args.id)
    if (provider && 'ackColdRestore' in provider && typeof provider.ackColdRestore === 'function') {
      provider.ackColdRestore(args.id)
    }
  })

  // Why: renderer ACKs bound main→renderer terminal delivery without stopping
  // PTY ingestion. Agent/status consumers still see every chunk through the
  // provider/runtime path while background renderer writes wait their turn.
  ipcMain.on(
    'pty:ackData',
    (_event, args: { id: string; charCount?: number; processedChars?: number }) => {
      lastAckReceivedAtMs = Date.now()
      // Why: a live ACK channel means a future unanswered probe is a fresh
      // diagnostic event, not a continuation of the last silent streak.
      deliveryResyncUnansweredWarnLogged = false
      let acknowledged = 0
      if (typeof args.processedChars === 'number' && Number.isFinite(args.processedChars)) {
        acknowledged = applyCumulativeAck(args.id, Math.max(0, args.processedChars))
      } else {
        // Why: tolerate legacy per-chunk delta payloads — dev hot-reload can
        // pair an old renderer with a new main. Keyed by field presence.
        const accounting = rendererDeliveryAccountingByPty.get(args.id)
        const delta = Number.isFinite(args.charCount) ? Math.max(0, args.charCount ?? 0) : 0
        acknowledged = accounting ? applyCumulativeAck(args.id, accounting.ackedChars + delta) : 0
      }
      tryGetProviderForPty(args.id)?.acknowledgeDataEvent(args.id, acknowledged)
      recordPtyRendererDeliveryPressure()
      if (pendingData.size > 0 && !flushTimer) {
        schedulePendingDataFlush(0)
      }
    }
  )

  ipcMain.on(
    'pty:deliveryResyncResponse',
    (_event, args: { requestId: number; processedCharsByPty: Record<string, number> }) => {
      if (
        deliveryResyncOutstandingRequestId === null ||
        args?.requestId !== deliveryResyncOutstandingRequestId
      ) {
        return
      }
      clearDeliveryResyncProbe()
      deliveryResyncUnansweredWarnLogged = false
      // Why: max-merge — the renderer's cumulative totals are authoritative
      // for what it processed; reconciling them drains exactly the in-flight
      // debt left by lost ACKs, nothing more.
      for (const [id, processedChars] of Object.entries(args.processedCharsByPty ?? {})) {
        if (typeof processedChars !== 'number' || !Number.isFinite(processedChars)) {
          continue
        }
        const acknowledged = applyCumulativeAck(id, Math.max(0, processedChars))
        if (acknowledged > 0) {
          tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
        }
      }
      recordPtyRendererDeliveryPressure()
      if (pendingData.size > 0 && !flushTimer) {
        schedulePendingDataFlush(0)
      }
    }
  )

  // Why invoke + renderer-initiated: the field wedge (v1.4.121-rc.0 snapshot,
  // 2026-07-06) kills every main→renderer push channel while invoke stays
  // alive, so the solicited-resync probe above can never be answered there.
  // This is the same reconcile, ridden over the direction proven to work, plus
  // a write-off lane for bytes the renderer provably never received.
  ipcMain.handle(
    'pty:reportRendererDeliveryState',
    (_event, args: PtyRendererDeliveryStateReport): PtyRendererDeliveryHealthReply => {
      // Extra repair lane for the lost-ACK variant: identical max-merge to the
      // resync response, so a heal is only reached when merging cannot drain.
      for (const [id, processedChars] of Object.entries(args?.processedCharsByPty ?? {})) {
        if (typeof processedChars !== 'number' || !Number.isFinite(processedChars)) {
          continue
        }
        const acknowledged = applyCumulativeAck(id, Math.max(0, processedChars))
        if (acknowledged > 0) {
          tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
        }
      }
      let writtenOff: PtyDeliveryWriteOff[] = []
      // Why the main-side ACK-silence check: the renderer's two silent ticks
      // already argue for a wedge; requiring main to have seen no ACK either
      // keeps a buggy/foreign caller from writing off live delivery.
      if (
        args?.heal === true &&
        rendererInFlightTotalChars > 0 &&
        (lastAckReceivedAtMs === null ||
          Date.now() - lastAckReceivedAtMs >= PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS)
      ) {
        writtenOff = writeOffLostRendererDelivery(args)
      }
      recordPtyRendererDeliveryPressure()
      if (pendingData.size > 0 && !flushTimer) {
        schedulePendingDataFlush(0)
      }
      let inFlightPtyCount = 0
      for (const accounting of rendererDeliveryAccountingByPty.values()) {
        if (accounting.sentChars - accounting.ackedChars > 0) {
          inFlightPtyCount++
        }
      }
      return {
        inFlightTotalChars: rendererInFlightTotalChars,
        inFlightPtyCount,
        msSinceLastAck: lastAckReceivedAtMs === null ? null : Date.now() - lastAckReceivedAtMs,
        ...(writtenOff.length > 0 ? { writtenOff } : {})
      }
    }
  )

  // Why: the renderer sends this once its pty:data listener is live (per page
  // load / reload). Until it arrives, sends are held so boot-window bytes can't
  // drop into a listener-less page and pin the delivery gate; on arrival, flush
  // the backlog that accrued during the boot window.
  ipcMain.removeAllListeners('pty:rendererDispatcherReady')
  ipcMain.on('pty:rendererDispatcherReady', (event) => {
    // Why: the reconcile below destructively clears delivery accounting, so a
    // straggler handshake from a dying window must not reset the new window.
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents)) {
      return
    }
    // Why: the handshake is one-shot per page load, so receiving it while the gate
    // is already open means a fresh page loaded but its lifecycle reset was missed —
    // a main-frame reload overlapped by an in-page subframe load emits no
    // did-start-loading, and the watchdog may have force-opened the gate — leaving
    // main holding the dead page's in-flight accounting, which permanently gates the
    // survivors. Reconcile by clearing that stale accounting before re-opening.
    if (rendererPtyDispatcherReady) {
      resetRendererDeliveryAccountingForLifecycleReset()
    }
    // Why: real handshake landed — cancel the self-heal watchdog so it can't later
    // force-open the gate and inflate rendererDispatcherReadyForcedCount.
    clearDispatcherReadyWatchdog()
    rendererPtyDispatcherReady = true
    schedulePendingDataFlush(0)
  })

  ipcMain.removeAllListeners('pty:setActiveRendererPty')
  ipcMain.on('pty:setActiveRendererPty', (_event, args: { id: string; active: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Why: this is a renderer scheduling hint only. PTY reads, runtime state,
    // and notifications continue for inactive terminals; active panes merely
    // get first chance at the bounded renderer output reserve.
    if (args.active) {
      activeRendererPtys.add(args.id)
    } else {
      activeRendererPtys.delete(args.id)
    }
    if (pendingData.size > 0 && !flushTimer) {
      schedulePendingDataFlush(0)
    }
  })

  ipcMain.removeAllListeners('pty:setRendererPtyVisible')
  ipcMain.on('pty:setRendererPtyVisible', (_event, args: { id: string; visible: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Why: data produced while no renderer can see this PTY must keep that origin
    // through batching, even if the user switches back before the flush lands.
    rendererVisibilityKnownPtys.add(args.id)
    if (args.visible) {
      visibleRendererPtys.add(args.id)
    } else {
      visibleRendererPtys.delete(args.id)
    }
    syncPtyBackgroundedDelivery(args.id, 'visibility-report')
  })

  ipcMain.removeAllListeners('pty:setHiddenRendererPty')
  ipcMain.on('pty:setHiddenRendererPty', (_event, args: { id: string; hidden: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    mainDeliveryBreadcrumbs.record(args.hidden === true ? 'gate-mark' : 'gate-unmark', {
      id: redactPtyIdForDiagnostics(args.id)
    })
    if (args.hidden === true) {
      markHiddenRendererPty(args.id)
      // Why: bytes already queued for a newly hidden PTY are model-owned
      // state; drop them now instead of holding them under ACK starvation.
      // Reveal restores from the snapshot.
      const pending = pendingData.get(args.id)
      if (pending && shouldDropHiddenRendererPtyData(args.id, getSettings?.())) {
        pendingData.delete(args.id)
        updateProducerFlowControl(args.id)
        pendingOverflowMarkedPtys.delete(args.id)
        const drop = recordHiddenRendererPtyDataDrop(args.id, pending.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(
            args.id,
            'hidden-drop',
            runtime?.getPtyOutputSequence(args.id)
          )
        }
        recordPtyRendererDeliveryPressure()
      }
      syncPtyBackgroundedDelivery(args.id, 'gate-mark')
      return
    }
    const { droppedWhileHidden } = unmarkHiddenRendererPty(args.id)
    syncPtyBackgroundedDelivery(args.id, 'gate-unmark')
    // Why: a renderer reload or remount can replace the view that latched
    // restore-needed from the first-drop marker. Re-emit on unhide so the
    // (possibly fresh) visible view still pulls the model snapshot covering
    // the dropped bytes. If the original view is still alive this can trigger
    // a redundant second restore — accepted: a snapshot replay is cheap and
    // idempotent, while a missed restore leaves a corrupt pane.
    if (droppedWhileHidden) {
      sendModelRestoreNeededMarker(args.id, 'unhide', runtime?.getPtyOutputSequence(args.id))
    }
  })

  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Why validate-or-drop: the responder must never store a malformed
    // palette — a wrong color reply breaks TUI theme detection worse than
    // the documented silent-until-first-push behavior.
    const attributes = validateTerminalViewAttributes(args)
    if (attributes) {
      setTerminalViewAttributes(attributes)
    }
  })

  ipcMain.removeAllListeners('pty:setPtyDeliveryInterest')
  ipcMain.on('pty:setPtyDeliveryInterest', (_event, args: { id: string; interested: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Why: explicit delivery-interest signal from renderer byte sidecars —
    // any interest suppresses the hidden-delivery gate so
    // raw-byte consumers keep receiving while the view is hidden or parked.
    // Deliberately NOT synced to the daemon backlog pacer: interest consumers
    // tolerate paced data, and interest churn must not un-pace a flood.
    setRendererPtyDeliveryInterest(args.id, args.interested === true)
  })

  ipcMain.removeAllListeners('pty:signal')
  ipcMain.on('pty:signal', (_event, args: { id: string; signal: string }) => {
    tryGetProviderForPty(args.id)
      ?.sendSignal(args.id, args.signal)
      .catch(() => {})
  })

  ipcMain.removeAllListeners('pty:clearBuffer')
  ipcMain.on('pty:clearBuffer', (_event, args: { id: string }) => {
    // Why: the renderer already cleared its own xterm buffer. This clears the
    // PTY-side state (ConPTY screen buffer, daemon emulator, SSH host buffer)
    // so the next prompt repaint doesn't land at a stale cursor row.
    tryGetProviderForPty(args.id)
      ?.clearBuffer(args.id)
      .catch(() => {})
    runtime?.clearHeadlessTerminalBuffer(args.id).catch(() => {})
  })

  ipcMain.handle('pty:kill', async (_event, args: { id: string; keepHistory?: boolean }) => {
    const ownedConnectionId = ptyOwnership.get(args.id)
    const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(args.id) : null
    const connectionId = ownedConnectionId ?? parsedSshId?.connectionId
    const provider = connectionId ? sshProviders.get(connectionId) : tryGetProviderForPty(args.id)
    if (!provider && connectionId) {
      // Why: detached SSH PTYs intentionally keep ownership after their
      // provider is unregistered; hydrated app-scoped ids can also arrive
      // before ownership is rebuilt. Tombstone instead of falling back local.
      finishPtyShutdown(args.id, connectionId, store)
      runtime?.onPtyExit(args.id, -1)
      rememberSyntheticKillExit(args.id)
      sendPtyExitToRenderer({ id: args.id, code: -1 })
      return
    }
    const shutdownProvider = provider ?? getProviderForPty(args.id)
    let providerExitObserved = false
    try {
      providerExitObserved = await shutdownProviderAndDetectExit(shutdownProvider, args.id, {
        immediate: true,
        keepHistory: args.keepHistory ?? false
      })
    } catch (err) {
      if (!isPtyAlreadyGoneError(err)) {
        // Why: a failed SSH shutdown can leave the remote process alive in
        // the relay grace window; daemon failures have the same risk locally.
        // Keep ownership/lease state so the user can retry.
        throw err
      }
      /* session already dead — cleanup below handles the rest */
    }
    // Why: some shutdown paths do not emit onExit through the provider listener.
    // Explicit cleanup is idempotent and covers already-dead PTYs.
    finishPtyShutdown(args.id, connectionId, store)
    if (!providerExitObserved) {
      runtime?.onPtyExit(args.id, -1)
      rememberSyntheticKillExit(args.id)
      sendPtyExitToRenderer({ id: args.id, code: -1 })
    }
  })

  ipcMain.handle(
    'pty:listSessions',
    async (): Promise<{ id: string; cwd: string; title: string }[]> => {
      const providerSessions = await Promise.all([
        Promise.resolve({
          connectionId: null as string | null,
          sessions: await localProvider.listProcesses()
        }),
        ...Array.from(sshProviders.entries(), async ([connectionId, provider]) => ({
          connectionId,
          sessions: await provider.listProcesses().catch(() => [])
        }))
      ])
      const deduped = new Map<string, { id: string; cwd: string; title: string }>()
      for (const { connectionId, sessions } of providerSessions) {
        for (const session of sessions) {
          // Why: SessionsStatusSegment kill actions only send the PTY id back
          // through IPC. Rebuild ownership while listing so remote sessions
          // discovered after reconnect still route to their original provider.
          ptyOwnership.set(session.id, connectionId)
          deduped.set(session.id, session)
        }
      }
      return Array.from(deduped.values())
    }
  )

  ipcMain.handle('pty:hasPty', async (_event, args: { id: string }): Promise<boolean | null> => {
    const ownedConnectionId = ptyOwnership.get(args.id)
    const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(args.id) : null
    const provider = parsedSshId
      ? sshProviders.get(parsedSshId.connectionId)
      : tryGetProviderForPty(args.id)
    if (!provider?.hasPty) {
      return null
    }
    try {
      return provider.hasPty(args.id)
    } catch {
      // Why: liveness is only allowed to close panes on an authoritative false.
      return null
    }
  })

  ipcMain.handle(
    'pty:hasChildProcesses',
    async (_event, args: { id: string }): Promise<boolean> => {
      if (!hasPtyProviderForInspection(args.id)) {
        return false
      }
      return getProviderForPty(args.id).hasChildProcesses(args.id)
    }
  )

  ipcMain.handle(
    'pty:getForegroundProcess',
    async (_event, args: { id: string }): Promise<string | null> => {
      if (!hasPtyProviderForInspection(args.id)) {
        return null
      }
      return getProviderForPty(args.id).getForegroundProcess(args.id)
    }
  )

  ipcMain.handle(
    'pty:confirmForegroundProcess',
    async (_event, args: { id: string }): Promise<string | null> => {
      if (!hasPtyProviderForInspection(args.id)) {
        return null
      }
      const provider = getProviderForPty(args.id)
      // Why: falling back to the cached foreground API would turn stale
      // process identity into shell/agent authority at a command boundary.
      return provider.confirmForegroundProcess?.(args.id) ?? null
    }
  )

  // Why: renderer needs the live shell cwd when the user presses Cmd+D so
  // the new split pane inherits the source pane's cwd instead of the
  // worktree root. Routed through getProviderForPty so local and SSH PTYs
  // use the same code path. Providers return '' when the id is unknown or
  // the platform cannot resolve a cwd (Windows); the renderer treats ''
  // as "fall through to the next fallback layer".
  ipcMain.handle('pty:getCwd', async (_event, args: { id: string }): Promise<string> => {
    try {
      return await getProviderForPty(args.id).getCwd(args.id)
    } catch {
      return ''
    }
  })

  // Why: the renderer forwards resizes fire-and-forget and otherwise has no way
  // to learn the PTY's actual size. A resize dropped main-side (suppression
  // window, mobile-driver gate, or a provider no-op) OR daemon/SSH-side (the
  // remote resize notify is unacked and can be silently dropped — session not
  // yet alive, exited, invalid dims, cold-restore snapshot-col coercion) leaves
  // the renderer believing it synced when it did not, so a later same-cols
  // layout never re-forwards and the TUI stays garbled. ptySizes records only
  // the REQUESTED size, so it cannot reveal such a drop. Prefer the provider's
  // APPLIED size (node-pty's cached winsize / the daemon emulator's dims, which
  // track the subprocess resize) so the renderer's resume drift-check sees the
  // truth; fall back to ptySizes only when the provider can't report (no
  // getAppliedSize, e.g. SSH relay, or an unknown id) — a null then reads as
  // "cannot confirm", which the renderer treats as a cue to re-forward once.
  ipcMain.handle(
    'pty:getSize',
    async (_event, args: { id: string }): Promise<{ cols: number; rows: number } | null> => {
      try {
        const applied = await tryGetProviderForPty(args.id)?.getAppliedSize?.(args.id)
        if (applied) {
          return applied
        }
      } catch {
        // Fall through to the requested-size cache on any provider/RPC failure
        // so a dead daemon/relay never blocks or throws across the IPC boundary.
      }
      return ptySizes.get(args.id) ?? null
    }
  )

  // Why: pre-signal handshake handlers. See
  // docs/mobile-prefer-renderer-scrollback.md and the rationale on
  // `pendingByPaneKey` above. The IPC contract is: renderer awaits declare
  // (capturing the returned gen), awaits pty:spawn, then registers its
  // serializer locally and calls settle (echoing the gen). On spawn rejection
  // or pane unmount before settle, renderer calls clear with the same gen.
  ipcMain.handle(
    'pty:declarePendingPaneSerializer',
    async (event, args: { paneKey?: unknown }): Promise<number> => {
      if (!isValidPaneKey(args.paneKey)) {
        throw new Error('Invalid paneKey')
      }
      return declarePendingPaneSerializer(args.paneKey, event?.sender)
    }
  )

  ipcMain.handle(
    'pty:settlePaneSerializer',
    async (_event, args: { paneKey?: unknown; gen?: unknown }): Promise<void> => {
      if (!isValidPaneKey(args.paneKey) || typeof args.gen !== 'number') {
        return
      }
      settlePendingPaneSerializer(args.paneKey, args.gen)
      // Why: settle means the renderer has registered its serializer locally
      // for whatever ptyId came back from spawn. The renderer doesn't carry
      // the ptyId back through this IPC because the cooperation gate ran
      // pre-spawn; instead we mark the pane as authoritative by paneKey →
      // ptyId via the existing paneKeyPtyId mapping populated at spawn.
      const ptyId = paneKeyPtyId.get(args.paneKey)
      if (ptyId) {
        rendererSerializerByPtyId.add(ptyId)
      }
    }
  )

  ipcMain.handle(
    'pty:clearPendingPaneSerializer',
    async (_event, args: { paneKey?: unknown; gen?: unknown }): Promise<void> => {
      if (!isValidPaneKey(args.paneKey) || typeof args.gen !== 'number') {
        return
      }
      settlePendingPaneSerializer(args.paneKey, args.gen)
    }
  )
}

export function registerHeadlessPtyRuntime(
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store
): void {
  // Why: headless `orca serve` has no renderer window, but the runtime still
  // needs the same PTY controller and provider listeners as desktop so remote
  // clients can create, stream, inspect, and stop terminals.
  const headlessWindow = {
    isDestroyed: () => true,
    webContents: {
      send: () => {},
      on: () => {},
      removeListener: () => {}
    }
  } as unknown as BrowserWindow
  registerPtyHandlers(
    headlessWindow,
    runtime,
    getSelectedCodexHomePath,
    getSettings,
    prepareClaudeAuth,
    store
  )
}

/**
 * Kill in-process local PTYs. Daemon-backed PTYs are preserved by daemon disconnect.
 */
export function killAllPty(): void {
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.killAll()
  }
}
