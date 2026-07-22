/* eslint-disable max-lines -- Why: PTY IPC is centralized in one main-process module so spawn env scoping, lifecycle cleanup, process inspection, and renderer IPC stay behind one audited boundary. */
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
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
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
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import {
  isWslShellName,
  resolveLocalWindowsTerminalRuntimeOptions
} from '../../shared/local-windows-terminal-runtime'
import { applyTerminalGitCredentialPromptGuard } from './terminal-git-credential-guard'
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
} from '../providers/ssh-pty-errors'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { createPtySpawnTiming } from './pty-spawn-timing'
import {
  isSafePtySessionId,
  mintPtySessionId,
  ptySessionIdForAgentCreateOperation
} from '../daemon/pty-session-id'
import { resolveWslSessionContext } from '../daemon/wsl-session-context'
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
import { RendererTerminalSerializerReadiness } from './renderer-terminal-serializer-readiness'
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
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import {
  agentSessionOwnerBindingsEqual,
  ClaimedAgentPtyOwnerRegistry
} from '../../shared/claimed-agent-pty-owner'
import {
  clearMigrationUnsupportedPty,
  clearMigrationUnsupportedPtysForPaneKey
} from '../agent-hooks/migration-unsupported-pty-state'
import { parseWslPath } from '../wsl'
import { mergePersistedWindowsPath } from '../pty/windows-environment-path'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { PtyProducerFlowController } from './pty-producer-flow-control'
import { beginTerminalInstall } from './watcher-removal-gate'
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
import { isCodexSystemDefaultRealHomeEnabled } from '../codex/codex-real-home-flag'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { resolveSetupAgentSequenceLaunchCommand } from '../../shared/setup-agent-sequencing'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getStartupTerminalColorQueryReplyColors } from './terminal-startup-color-query-replies'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus
} from '../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId (null = local provider).

let localProvider: IPtyProvider = new LocalPtyProvider()
type FreshLocalFallbackProvider = IPtyProvider & {
  routesFreshSpawnsToLocalProvider?: true
}
const sshProviders = new Map<string, IPtyProvider>()
const SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS = 30_000
// Why: kill switch — flip to disable producer flow control (pause/resume) without untangling the wiring.
const PRODUCER_FLOW_CONTROL_ENABLED = true
// Why: post-spawn write/resize/kill calls carry only the PTY ID; map it to its connectionId so ops route to the right provider.
const ptyOwnership = new Map<string, string | null>()
const ptyIncarnationById = new Map<string, string>()

export function isCurrentPtyExit(payload: { id: string; incarnationId?: string }): boolean {
  const current = ptyIncarnationById.get(payload.id)
  return !current || payload.incarnationId === current
}
// Why: mobile clients must mirror desktop PTY geometry even before the renderer can provide an xterm snapshot (e.g. right after tab creation).
const ptySizes = new Map<string, { cols: number; rows: number }>()
// Why: the "recent user input" signal is PTY-scoped and must be cleared by every teardown path, incl. SSH/daemon shutdowns that skip the local exit listener.
const lastInputAtByPty = new Map<string, number>()
const interactiveOutputCharsByPty = new Map<string, number>()
const activeRendererPtys = new Set<string>()
const visibleRendererPtys = new Set<string>()
const rendererVisibilityKnownPtys = new Set<string>()
const pendingHiddenRendererResizeOutputPtys = new Set<string>()
const deliveredHiddenRendererResizeOutputPtys = new Set<string>()
const KEEP_HISTORY_STOP_SETTLE_MS = 1_000
const KEEP_HISTORY_STOP_POLL_MS = 100
// Why: track spawn-time paneKey so teardown can clear the agent-hooks server's per-paneKey cache, which otherwise grows unbounded as panes come and go.
const ptyPaneKey = new Map<string, string>()
// Why: reverse of ptyPaneKey — callers with a paneKey from outside the PTY lifecycle (e.g. agent-hook status routing) need the ptyId; kept in lock-step via the same sites.
const paneKeyPtyId = new Map<string, string>()

const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_ENDPOINT',
  // Why: PR 2778 briefly exported this path; keep deleting stale inherited values so older PTYs can't leak the reverted path.
  'ORCA_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

export function getPtyIdForPaneKey(paneKey: string): string | undefined {
  return paneKeyPtyId.get(paneKey)
}

// Why: let consumers tear down paneKey-scoped state on PTY exit so their timers can't leak; a callback registry keeps the cross-module dependency narrow.
type PaneKeyTeardownListener = (paneKey: string) => void
const paneKeyTeardownListeners = new Set<PaneKeyTeardownListener>()

export function registerPaneKeyTeardownListener(listener: PaneKeyTeardownListener): () => void {
  paneKeyTeardownListeners.add(listener)
  return () => paneKeyTeardownListeners.delete(listener)
}

// Why: renderer pre-declares serializer ownership before pty:spawn to suppress the daemon-snapshot seed; gen tokens prevent paneKey-reuse races on teardown. See docs/mobile-prefer-renderer-scrollback.md.
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
// Why: mobile materialization and a newly-focused pane can race to spawn the same leaf; key by paneKey so the loser adopts the winner's PTY.
const paneSpawnReservationsByPaneKey = new Map<string, PaneSpawnReservation>()
// Why: one main process can route the same remote provider namespace through
// multiple SSH relays; coordinate claims above every provider boundary too.
const agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
let agentSessionOwnerReconciliation: Promise<void> | null = null

function assertSpawnReplyWasLive(result: PtySpawnResult): void {
  if (!result.exitedBeforeSpawnReply) {
    return
  }
  // Why: lower owners can resolve a different canonical id, so controller-local pending ids cannot prove this exit.
  throw Object.assign(new Error('agent_session_exited_during_start'), {
    agentSessionOperationOutcome: 'unknown' as const
  })
}

async function reconcileAgentSessionOwnerListings(): Promise<void> {
  if (agentSessionOwnerReconciliation) {
    return await agentSessionOwnerReconciliation
  }
  const reconciliation = (async () => {
    const providers: { provider: IPtyProvider; connectionId: string | null }[] = [
      { provider: localProvider, connectionId: null },
      ...Array.from(sshProviders, ([connectionId, provider]) => ({ provider, connectionId }))
    ]
    const listings = await Promise.all(
      providers.map(async ({ provider, connectionId }) => ({
        connectionId,
        sessions: await provider.listProcesses()
      }))
    )
    const advertisedOwners: AgentSessionOwnerBinding[] = []
    const advertisedOwnerSessions: {
      id: string
      connectionId: string | null
      incarnationId: string
    }[] = []
    for (const { connectionId, sessions } of listings) {
      for (const session of sessions) {
        const incarnationId = session.incarnationId
        let hasAdvertisedOwner = false
        for (const owner of session.agentSessionOwners ?? []) {
          if (owner.ptyId !== session.id || !isPtyIncarnationId(incarnationId)) {
            // Why: a recovered claim without process-incarnation proof cannot safely reject a delayed exit.
            throw new Error('agent_session_ownership_unknown')
          }
          advertisedOwners.push(owner)
          hasAdvertisedOwner = true
        }
        if (hasAdvertisedOwner && isPtyIncarnationId(incarnationId)) {
          advertisedOwnerSessions.push({ id: session.id, connectionId, incarnationId })
        }
      }
    }
    agentSessionOwners.reconcileAuthoritative(advertisedOwners, {
      // Why: an unregistered relay can still own a live PTY during reconnect;
      // only providers that serialize claims may make listing absence authoritative.
      isInAuthoritativeScope: (owner) => {
        const provider = tryGetProviderForAgentSessionOwner(owner.ptyId)
        return provider?.providesAgentSessionOwnerListings?.(owner.ptyId) === true
      }
    })
    for (const session of advertisedOwnerSessions) {
      ptyOwnership.set(session.id, session.connectionId)
      ptyIncarnationById.set(session.id, session.incarnationId)
    }
  })()
  agentSessionOwnerReconciliation = reconciliation
  try {
    await reconciliation
  } finally {
    if (agentSessionOwnerReconciliation === reconciliation) {
      agentSessionOwnerReconciliation = null
    }
  }
}
// Why: bind the declaration generation directly to its spawn result. PTY ids
// are reusable and teardown callbacks carry no incarnation token, so teardown
// must never guess which pending renderer generation it owns.
const pendingPtyIdBySerializerGeneration = new Map<number, string>()
// Why: hasRendererSerializer probe needs a ptyId-keyed signal; a later spawn starts a fresh incarnation, subscription abort owns waiter cleanup.
const rendererSerializerReadiness = new RendererTerminalSerializerReadiness()

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
      pendingPtyIdBySerializerGeneration.delete(pending.gen)
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
  const replaced = pendingByPaneKey.get(paneKey)
  if (replaced) {
    pendingPtyIdBySerializerGeneration.delete(replaced.gen)
  }
  pendingByPaneKey.set(paneKey, { gen, ownerWebContentsId: sender?.id ?? null })
  const existingPtyId = paneKeyPtyId.get(paneKey)
  if (existingPtyId) {
    pendingPtyIdBySerializerGeneration.set(gen, existingPtyId)
  }
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

function settlePendingPaneSerializer(paneKey: string, gen: number): boolean {
  if (pendingByPaneKey.get(paneKey)?.gen !== gen) {
    return false
  }
  pendingByPaneKey.delete(paneKey)
  return true
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
  // Why: process inspection is background polling; disconnected SSH hosts should read as idle, not raise repeated IPC errors.
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

function closeStartupQueryAuthorityForPty(ptyId: string): void {
  try {
    void Promise.resolve(tryGetProviderForPty(ptyId)?.closeStartupQueryAuthority?.(ptyId)).catch(
      () => {}
    )
  } catch {
    /* Best-effort handoff; the bounded source deadline remains the fallback. */
  }
}

function tryGetProviderForAgentSessionOwner(ptyId: string): IPtyProvider | undefined {
  const ownedConnectionId = ptyOwnership.get(ptyId)
  const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(ptyId) : null
  try {
    return getProvider(parsedSshId?.connectionId ?? ownedConnectionId)
  } catch {
    return undefined
  }
}

function normalizeNodePtySpawnError(err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const hintedMessage = addNodePtyRecoveryHint(rawMessage)
  if (hintedMessage === rawMessage && err instanceof Error) {
    return err
  }
  if (err instanceof Error) {
    // Why: preserve the original stack/name/custom fields while adding the same recovery hint as the pty:spawn path.
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

async function isProviderPtyLive(
  provider: IPtyProvider,
  ptyId: string,
  deadlineMs?: number
): Promise<boolean> {
  // Why: bound the liveness list RPC by the teardown deadline so a wedged daemon
  // fails fast; undefined keeps the provider default for all other callers.
  return (await provider.listProcesses(deadlineMs !== undefined ? { deadlineMs } : undefined)).some(
    (session) => session.id === ptyId
  )
}

async function isProviderAgentSessionOwnerLive(
  provider: IPtyProvider,
  owner: AgentSessionOwnerBinding
): Promise<boolean> {
  const session = (await provider.listProcesses()).find((candidate) => candidate.id === owner.ptyId)
  if (!session) {
    return false
  }
  if (provider.providesAgentSessionOwnerListings?.(owner.ptyId) !== true) {
    // Why: in-process local owners cannot serialize the controller claim; exact incarnation
    // liveness keeps that claim authoritative until the normal PTY exit releases it.
    const expectedIncarnation = ptyIncarnationById.get(owner.ptyId)
    return expectedIncarnation !== undefined && session.incarnationId === expectedIncarnation
  }
  return Boolean(
    session.agentSessionOwners?.some((candidate) =>
      agentSessionOwnerBindingsEqual(candidate, owner)
    )
  )
}

async function verifyPtyStopped(
  provider: IPtyProvider,
  ptyId: string,
  opts: { keepHistory?: boolean; deadlineMs?: number } | undefined
): Promise<boolean> {
  if (await isProviderPtyLive(provider, ptyId, opts?.deadlineMs)) {
    return false
  }
  if (!opts?.keepHistory) {
    return true
  }
  const deadline = Date.now() + KEEP_HISTORY_STOP_SETTLE_MS
  while (Date.now() < deadline) {
    await delay(KEEP_HISTORY_STOP_POLL_MS)
    if (await isProviderPtyLive(provider, ptyId, opts?.deadlineMs)) {
      return false
    }
  }
  return true
}

function finishPtyShutdown(
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined
): string | undefined {
  const incarnationId = ptyIncarnationById.get(id)
  clearProviderPtyState(id)
  if (connectionId) {
    store?.markSshRemotePtyLease(connectionId, getRelayPtyId(connectionId, id), 'terminated')
  }
  ptyOwnership.delete(id)
  markClaudePtyExited(id)
  return incarnationId
}

// ─── Host PTY env assembly ──────────────────────────────────────────
// Why: centralize host-local env injections so both spawn paths (local + daemon) get them; implemented twice they drifted, silently breaking daemon PTYs.

export type BuildPtyHostEnvOptions = {
  isPackaged: boolean
  userDataPath: string
  selectedCodexHomePath: string | null
  skipCodexHomeEnv?: boolean
  /** System-default real-home routing (flag ON): inject no managed CODEX_HOME,
   *  and strip only an inherited Orca-owned override so nested Orca panes do not
   *  leak the parent's managed home. A user-set CODEX_HOME is preserved. */
  stripInheritedOrcaCodexHome?: boolean
  githubAttributionEnabled: boolean
  /** Launch command the renderer chose (e.g. 'pi', 'omp', 'claude'); resolves the per-agent
   *  extension target for Pi/OMP. Undefined for bare shells → defaults to Pi. NEVER infer from
   *  disk presence (cross-agent shadowing when both dirs exist). */
  launchCommand?: string
  /** Trusted agent identity for wrapped commands that cannot be recognized from text. */
  launchAgent?: TuiAgent
  shellPath?: string
  isWsl?: boolean
  /** Distro for WSL spawns (null = Windows default distro); drives the WSL hook relay + endpoint repoint. Only read when isWsl. */
  wslDistro?: string | null
  agentStatusHooksEnabled: boolean
  networkProxySettings?: NetworkProxySettings
  /** Keep indexed Git config off the sparse daemon wire; the daemon appends guard entries after merging its inherited env. */
  deferGitConfigGuardToDaemon?: boolean
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
  // Why: host env injection prepends Orca's shims; Claude Agent Teams must still resolve our fake tmux before any real tmux.
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

// Why: with the real-home flag ON, a host system-default launch resolves to a
// null managed home. Signal the env builder to strip a nested-Orca-inherited
// override instead of injecting one, so Codex runs on the user's own ~/.codex.
function shouldStripInheritedOrcaCodexHome(args: {
  target: CodexAccountSelectionTarget
  selectedCodexHomePath: string | null
  skipCodexHomeEnv: boolean
  settings: GlobalSettings | undefined
}): boolean {
  return (
    args.target.runtime === 'host' &&
    args.selectedCodexHomePath === null &&
    !args.skipCodexHomeEnv &&
    isCodexSystemDefaultRealHomeEnabled()
  )
}

const CODEX_HOME_ENV_KEYS = ['CODEX_HOME', 'ORCA_CODEX_HOME'] as const

// Why: system-default real-home routing runs Codex on the user's own ~/.codex.
// Nested Orca panes inherit the parent's Orca-owned override; strip only that
// (CODEX_HOME matching Orca's private ORCA_CODEX_HOME marker), and always drop
// the marker so a shell-ready wrapper cannot restore the managed home. A
// user-set CODEX_HOME with no Orca marker is preserved untouched (see #8606).
function stripInheritedOrcaCodexHomeOverride(baseEnv: Record<string, string>): void {
  for (const key of getLocalOrcaCodexHomeEnvKeysToDelete(baseEnv)) {
    delete baseEnv[key]
  }
}

// Why: in-process spawns share main's inherited environment, so equality with
// the private marker is authoritative here. Persistent daemons compare locally.
function getLocalOrcaCodexHomeEnvKeysToDelete(env: Record<string, string>): string[] {
  const inheritedOrcaOverride = env.ORCA_CODEX_HOME ?? process.env.ORCA_CODEX_HOME
  const inheritedCodexHome = env.CODEX_HOME ?? process.env.CODEX_HOME
  const keysToDelete = ['ORCA_CODEX_HOME']
  if (inheritedOrcaOverride && inheritedCodexHome === inheritedOrcaOverride) {
    keysToDelete.push('CODEX_HOME')
  }
  return keysToDelete
}

export type GetSelectedCodexHomePath = (
  target?: CodexAccountSelectionTarget,
  launchEnv?: NodeJS.ProcessEnv,
  launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
) => string | null
export type PrepareCodexSessionResume = (args: {
  providerSession: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  workspacePath?: string
}) => Promise<{ codexHomePath: string | null } | null>
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
  // Why: if PI_CODING_AGENT_DIR is a restored Orca overlay with no source shadow, remirroring leaks another agent's overlay tree; fall through to defaults.
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

function removeCodexHomeDeletionRequests(keys: string[] | undefined): string[] | undefined {
  // Why: resume provenance is launch-authoritative; late deletions must not fall back to the current account.
  const filtered = keys?.filter((key) => key !== 'CODEX_HOME' && key !== 'ORCA_CODEX_HOME')
  return filtered?.length ? filtered : undefined
}

function getInheritedAgentHookEnvKeysToDelete(
  spawnEnv: Record<string, string> | undefined
): string[] {
  const env = spawnEnv ?? {}
  // Why: providers merge process.env after cleanup; delete stale hook keys without dropping fresh coordinates buildPtyHostEnv set.
  return AGENT_HOOK_RUNTIME_ENV_KEYS.filter((key) => env[key] === undefined)
}

// Why: a nested terminal can inherit prior OpenCode/Pi/OMP overlay env; restore the user's recorded source dir, else strip only Orca-owned values.
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
  // Why: with no recorded source dir, an inherited OPENCODE_CONFIG_DIR is Orca-owned, not user config; treating it as user config makes child Orcas mirror the hook dir.
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
 * Do NOT call when `args.connectionId` is set (SSH): every injection is host-loopback
 * or references local filesystem paths meaningless to a remote shell.
 */
export function buildPtyHostEnv(
  id: string,
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): Record<string, string> {
  mergePersistedWindowsPath(baseEnv)
  Object.assign(baseEnv, buildConfiguredProxyEnv(opts.networkProxySettings))

  // Why: local path's baseEnv includes process.env but the daemon path doesn't (fork inheritance, not IPC); check both sources so guards stay in lock-step across spawn paths.
  const preexistingOpenCodeConfigDir = resolveOpenCodeSourceConfigDir(baseEnv)
  const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(baseEnv, opts.launchCommand)
  const piAgentKind = detectPiAgentKindFromCommand(launchCommandHint)
  const hasLaunchCommand =
    typeof launchCommandHint === 'string' && launchCommandHint.trim().length > 0

  // Why: unattended agents must fail instead of looping on OS credential prompts; user terminals keep normal Git behavior.
  applyTerminalGitCredentialPromptGuard(baseEnv, {
    launchCommand: launchCommandHint,
    isUnattended: opts.launchAgent !== undefined,
    deferGitConfigGuardToHost: opts.deferGitConfigGuardToDaemon
  })

  const shouldPrepareOmpShadow = piAgentKind === 'omp' || !hasLaunchCommand
  // Why: source shadows are agent-scoped; trusting the other kind's source reintroduces Pi/OMP extension-state shadowing.
  const preexistingPiAgentDir = resolvePiAgentSourceDir(baseEnv, 'pi')
  const preexistingOmpAgentDir =
    piAgentKind === 'omp'
      ? resolvePiAgentSourceDir(baseEnv, 'omp')
      : resolveScopedPiAgentSourceDir(baseEnv, 'omp')

  if (opts.agentStatusHooksEnabled) {
    // Why: OPENCODE_CONFIG_DIR is a single path, not a colon-list; mirror the user's value into an overlay so their plugins and Orca's status plugin coexist. See docs/opencode-config-dir-collision.md.
    Object.assign(baseEnv, openCodeHookService.buildPtyEnv(id, preexistingOpenCodeConfigDir))
    if (baseEnv.OPENCODE_CONFIG_DIR) {
      // Why: ~/.zshrc can re-export the user's default after spawn; shell-ready wrappers restore this PTY-scoped value.
      baseEnv.ORCA_OPENCODE_CONFIG_DIR = baseEnv.OPENCODE_CONFIG_DIR
      if (preexistingOpenCodeConfigDir) {
        // Why: nested Orca terminals inherit the overlay as OPENCODE_CONFIG_DIR; keep the real source so overlays don't mirror overlays.
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

  // Why: strip inherited hook coordinates before injecting this PTY's fresh loopback receiver, so nested-terminal callbacks route to the owning pane.
  for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
    delete baseEnv[key]
  }
  if (opts.agentStatusHooksEnabled) {
    Object.assign(baseEnv, agentHookServer.buildPtyEnv())
    if (opts.isWsl === true) {
      // Why: hook POSTs to 127.0.0.1 die inside WSL's NAT namespace; use the guest-resident relay's endpoint instead of the Windows one.
      const distro = opts.wslDistro ?? null
      wslHookRelayManager.ensureForDistro(distro)
      const guestEndpoint = wslHookRelayManager.getGuestEndpointFilePath(distro)
      if (guestEndpoint) {
        baseEnv.ORCA_AGENT_HOOK_ENDPOINT = guestEndpoint
      }
    }
  }

  // Why: PI_CODING_AGENT_DIR is the user's config/session root; install only Orca-owned extension files, don't override it.
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
    // Why: strip BOTH kinds' shadow vars so a nested PTY can't inherit a stale overlay from either agent.
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

  // Why: keep the Codex home override PTY-scoped so dev/prod Orcas don't share hooks through ~/.codex.
  if (opts.skipCodexHomeEnv) {
    delete baseEnv.CODEX_HOME
    delete baseEnv.ORCA_CODEX_HOME
  } else if (opts.selectedCodexHomePath) {
    baseEnv.CODEX_HOME = opts.selectedCodexHomePath
    // Why: user startup files may re-export CODEX_HOME; shell-ready wrappers restore this runtime home before Codex launches.
    baseEnv.ORCA_CODEX_HOME = opts.selectedCodexHomePath
  } else if (opts.stripInheritedOrcaCodexHome) {
    stripInheritedOrcaCodexHomeOverride(baseEnv)
  }

  // Why: WSL shells need the managed userData root for shell-ready wrappers; dev-mode terminals need the same export so `orca` targets the live dev instance.
  if (opts.isWsl) {
    baseEnv.ORCA_USER_DATA_PATH = opts.userDataPath
    // Why: managed WSL registration uses `orca-ide`; exposing that literal scopes agent guidance to WSL without a bare-orca shim.
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
    // Why: an empty PATH segment resolves as `.` in some shells (commands run from cwd); avoid a trailing delimiter.
    baseEnv.PATH = inheritedPath ? `${devCliBin}${delimiter}${inheritedPath}` : devCliBin
  } else if (process.platform === 'linux') {
    // Why: bare-`orca` shim scoped to Orca PTYs — Linux CLI installs as `orca-ide` to avoid shadowing GNOME's /usr/bin/orca screen reader (stablyai/orca#7904).
    const shimDir = ensureLinuxTerminalOrcaCliShimDir({ userDataPath: opts.userDataPath })
    if (shimDir) {
      const inheritedEntries = readInheritedPath(baseEnv)
        .split(delimiter)
        .filter((entry) => entry.length > 0 && entry !== shimDir)
      baseEnv.PATH = [shimDir, ...inheritedEntries].join(delimiter)
    }
  }

  // Why: PATH shims keep GitHub attribution scoped to Orca's own PTYs without rewriting user git config.
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

function beginPtySpawnForWorktree(
  worktreeId: string | undefined,
  cwd: string | undefined,
  connectionId: string | null | undefined
): () => void {
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  const installPaths = new Map<string, string>()
  for (const candidate of [worktreePath, cwd]) {
    if (candidate) {
      installPaths.set(normalizeRuntimePathForComparison(candidate), candidate)
    }
  }
  const finishes: (() => void)[] = []
  try {
    for (const candidate of installPaths.values()) {
      finishes.push(beginTerminalInstall(candidate, connectionId ?? undefined))
    }
  } catch (error) {
    // Why: worktree ID and cwd can be different roots; release earlier admissions before rejecting.
    finishes.toReversed().forEach((finish) => finish())
    throw error
  }
  return () => finishes.toReversed().forEach((finish) => finish())
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
 *  After daemon init this may be a DaemonPtyAdapter/DaemonPtyRouter, not LocalPtyProvider;
 *  callers needing LocalPtyProvider-specific methods must type-narrow or import the class. */
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
 * Remove transient PTY routing entries for a disconnected connection.
 * Claimed agent owners remain fenced because the relay process may survive and
 * prove the exact same generation after reconnect.
 */
export function clearPtyOwnershipForConnection(connectionId: string): void {
  for (const [ptyId, connId] of ptyOwnership) {
    if (connId === connectionId) {
      // Why: pane-scoped caches cannot route while disconnected, but claimed
      // ownership must survive until reconnect makes absence authoritative.
      clearProviderPtyState(ptyId, { preserveAgentSessionOwners: true })
      ptyOwnership.delete(ptyId)
    }
  }
}

// ─── Provider-scoped PTY state cleanup ──────────────────────────────

export function clearProviderPtyState(
  id: string,
  opts: { preserveAgentSessionOwners?: boolean } = {}
): void {
  if (!opts.preserveAgentSessionOwners) {
    agentSessionOwners.release(id)
  }
  // Why: OpenCode and Pi both allocate PTY-scoped runtime state outside the
  // node-pty process table. Centralizing provider cleanup avoids drift where a
  // new teardown path forgets to remove one provider's overlay/hook state.
  openCodeHookService.clearPty(id)
  piTitlebarExtensionService.clearPty(id)
  // Why: SSH exit/teardown paths bypass pty.ts's local onExit but still must release Claude account-switch guards.
  markClaudePtyExited(id)
  ptySizes.delete(id)
  ptyIncarnationById.delete(id)
  lastInputAtByPty.delete(id)
  interactiveOutputCharsByPty.delete(id)
  activeRendererPtys.delete(id)
  visibleRendererPtys.delete(id)
  rendererVisibilityKnownPtys.delete(id)
  pendingHiddenRendererResizeOutputPtys.delete(id)
  deliveredHiddenRendererResizeOutputPtys.delete(id)
  // Why: every teardown path funnels through here — hidden/interest gate bits must not outlive the PTY or a reused map entry could silently gate a new one.
  clearHiddenRendererPtyDeliveryState(id)
  clearBackgroundedDeliverySyncForPty(id)
  providerSnapshotRequiredPtys.delete(id)
  // Why: the Phase-5 ConPTY DA1 spawn record must not leak onto a reused id.
  clearNativeWindowsConptyPty(id)
  const paneKey = ptyPaneKey.get(id)
  const stillOwnsPaneKey = paneKey ? paneKeyPtyId.get(paneKey) === id : false
  // Why: drop the memory-collector registration so a dead PTY doesn't resolve its dead pid on every snapshot; no-op for never-registered (SSH-owned) PTYs.
  unregisterPty(id)
  // Why: cover paths that bypass runtime.onPtyExit (SSH reattach/shutdown, daemon spawn-failure) — else the watcher's per-PTY buffer and worktree binding outlive the PTY.
  advertisedUrlWatcher.unbindPty(id)
  clearMigrationUnsupportedPty(id)
  agentHookServer.clearPaneKeyAliasesForPty(id, {
    shouldClearStablePaneKey: (stablePaneKey) => {
      // Why: when this PTY never rebuilt ptyPaneKey after restart, alias ownership is our only proof — don't erase a newer PTY that now owns the same stable paneKey.
      const stablePaneOwner = paneKeyPtyId.get(stablePaneKey)
      if (stablePaneOwner && stablePaneOwner !== id) {
        return false
      }
      return !paneKey || (stillOwnsPaneKey && stablePaneKey === paneKey)
    }
  })
  // Why: clear the hook server's per-paneKey caches (via the spawn-time paneKey mapping, its only ptyId→paneKey correlation) so dead panes don't accumulate over process lifetime.
  if (paneKey) {
    if (stillOwnsPaneKey) {
      agentHookServer.clearPaneState(paneKey)
      paneKeyPtyId.delete(paneKey)
    }
    ptyPaneKey.delete(id)
    if (stillOwnsPaneKey) {
      // Why: notify AFTER dropping the paneKey↔ptyId entries so a listener re-reading the map sees post-teardown state; wrap each so one throw can't block the rest.
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

export function restorePtyIncarnation(id: string, incarnationId: string): void {
  if (!isPtyIncarnationId(incarnationId)) {
    throw new Error('Invalid PTY incarnation')
  }
  ptyIncarnationById.set(id, incarnationId)
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
// Why: the hidden-delivery gate registries mirror renderer state; a reload/crash destroys owners without unregistering, so they reset when the renderer is replaced (drop memory preserved).
let rendererGateResetLoadHandler: (() => void) | null = null
let rendererGateResetGoneHandler: (() => void) | null = null
let rendererGateResetWebContents: WebContents | null = null
// Why: the backgrounded-delivery dedupe map lives in the registerPtyHandlers closure but teardown funnels through module-scope clearProviderPtyState.
let clearBackgroundedDeliverySyncForPty: (id: string) => void = () => {}
// Why: after daemon keep-tail thinning main's mirror holds only the kept tail, so recovery must keep consulting the daemon's complete model until exit.
const providerSnapshotRequiredPtys = new Set<string>()
// Why: did-start-loading also fires for in-page subframe loads (notebook srcDoc iframes); a dedicated handler filters those via isLoadingMainFrame.
let rendererDidStartLoadingHandler: (() => void) | null = null

// Why: Restart daemon must re-bind provider→renderer listeners after replaceDaemonProvider swaps localProvider, else subscribers stay bound to the disposed adapter and new PTY data silently drops.
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
  /** Hidden-gated ptys the renderer ALSO reports visible/active — a contradiction that should be zero (v1.4.124-rc.2.perf field lead). */
  hiddenDeliveryGatedVisiblePtyCount: number
  hiddenDeliveryGatedActivePtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
  pendingDroppedChars: number
  /** One-paste freeze diagnostics: per-pty delivery table + event history. */
  diagnostics: PtyMainDeliveryDiagnostics
  // Why: a nonzero lastLifecycleResetClearedChars is the exact signature of the leaked-accounting freeze this reset fixes.
  rendererLifecycleResetCount: number
  lastLifecycleResetClearedChars: number
  // Why: the boot-window hold early-returns before ackGatedFlushSkipCount++, so these expose an otherwise-invisible held gate; forcedCount > 0 flags a watchdog self-heal.
  rendererPtyDispatcherReady: boolean
  rendererDispatcherReadyForcedCount: number
}

// Why module scope: breadcrumb writers live both inside registerPtyHandlers and outside it (renderer lifecycle resets).
const mainDeliveryBreadcrumbs = createPtyDeliveryBreadcrumbRing()
let lastPowerSuspendAtMs: number | null = null
let lastPowerResumeAtMs: number | null = null
let powerSignalBreadcrumbsInstalled = false

// Why: both field freeze variants correlate with display sleep; suspend/resume timestamps let breadcrumbs line up against the wake.
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
// Bridged into the registerPtyHandlers closure so the module-scope lifecycle-reset handler can zero closure-owned delivery accounting on renderer reload/crash.
let resetRendererDeliveryAccountingForLifecycleReset = (): void => {}
// Bridged so a re-registration can cancel the prior closure's dispatcher-ready watchdog before wiring its own.
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
  // A reload/crash in the breadcrumb history is load-bearing context for any freeze report.
  mainDeliveryBreadcrumbs.record('renderer-lifecycle-reset')
  // Why: renderer-owned hints die with the page; clear visibility so surviving daemon/SSH PTYs fail closed until the new renderer reports.
  activeRendererPtys.clear()
  visibleRendererPtys.clear()
  // Why: the dead page never ACKs its in-flight bytes, so leaked accounting would delivery-gate surviving PTYs forever after a reload/crash.
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
  // Why: did-start-loading also fires for in-page subframe loads (notebook srcDoc iframes); filter via isLoadingMainFrame so a subframe load can't clear pendingData and freeze the alive page.
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

// Why: Restart daemon must detach listeners AFTER synthetic pty:exit events fan out but BEFORE replaceDaemonProvider swaps the adapter; this export narrows that window to the caller.
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
    prepareCodexSessionResume?: PrepareCodexSessionResume
    awaitLocalPtyStartup?: () => Promise<void>
    awaitLocalPtyProviderStartup?: () => Promise<void>
    // Why: returns true once for the crash-recovery reload so its did-finish-load skips the orphan sweep and keeps live PTYs (#5787).
    isRecoveryReloadInFlight?: (webContentsId: number) => boolean
  }
): void {
  // Why: a re-registration means a new window owns delivery — cancel the prior closure's watchdog and neutralize its bridged reset so mark-hidden below can't arm a timer against the dead closure.
  clearRendererDispatcherReadyWatchdog()
  resetRendererDeliveryAccountingForLifecycleReset = () => {}
  registerRendererLifecycleResetHandlers(mainWindow.webContents)

  const getLocalPtyStartupPromise = (connectionId?: string | null): Promise<void> | undefined => {
    if (connectionId) {
      return undefined
    }
    // Why: during cold start the daemon provider swap overlaps first paint, so local spawns must wait; SSH/headless don't use the desktop daemon.
    return options?.awaitLocalPtyStartup?.()
  }

  const getLocalPtyProviderStartupPromise = (
    connectionId?: string | null
  ): Promise<void> | undefined => {
    if (connectionId) {
      return undefined
    }
    return options?.awaitLocalPtyProviderStartup?.() ?? options?.awaitLocalPtyStartup?.()
  }

  // Remove prior handlers so re-registration (e.g. macOS re-activate creating a new window) doesn't double-register.
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:listSessions')
  ipcMain.removeHandler('pty:hasPty')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeHandler('pty:confirmForegroundProcess')
  ipcMain.removeHandler('pty:getCwd')
  ipcMain.removeHandler('pty:getSize')
  ipcMain.removeAllListeners('pty:getAuthoritativeBufferSnapshotCapabilitiesSync')
  ipcMain.removeHandler('pty:declarePendingPaneSerializer')
  ipcMain.removeHandler('pty:settlePaneSerializer')
  ipcMain.removeHandler('pty:clearPendingPaneSerializer')
  ipcMain.removeHandler('pty:reportRendererSerializerReady')
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

  // Why: only LocalPtyProvider needs main-process hook injection; daemon-backed providers spawn subprocesses internally.
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
          ctx?.codexHomePathOverride
            ? ctx.codexHomePathOverride.value
            : (getSelectedCodexHomePath?.(codexSelectionTarget, baseEnv, {
                workspacePath: ctx?.cwd,
                launchAgent: ctx?.launchAgent
              }) ?? null)
        )
        const skipCodexHomeEnv = ctx?.isWsl === true && !selectedCodexHomePath
        const env = buildPtyHostEnv(id, baseEnv, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath,
          skipCodexHomeEnv,
          stripInheritedOrcaCodexHome: shouldStripInheritedOrcaCodexHome({
            target: codexSelectionTarget,
            selectedCodexHomePath,
            skipCodexHomeEnv,
            settings: getSettings?.()
          }),
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false,
          launchCommand: ctx?.command,
          launchAgent: ctx?.launchAgent,
          shellPath: ctx?.shellPath,
          isWsl: ctx?.isWsl,
          wslDistro: ctx?.wslDistro ?? null,
          agentStatusHooksEnabled: isAgentStatusHooksEnabled(getSettings?.()),
          networkProxySettings: getSettings?.()
        })
        // Why: agents need their terminal handle at process start to self-identify in orchestration messages without an extra RPC.
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
      onSpawned: (id, incarnationId) => runtime?.onPtySpawned(id, incarnationId),
      onExit: (id, code, incarnationId) => {
        if (!isCurrentPtyExit({ id, incarnationId })) {
          return
        }
        clearProviderPtyState(id)
        ptyOwnership.delete(id)
        markClaudePtyExited(id)
        runtime?.onPtyExit(id, code, incarnationId)
      },
      onData: (id, data, timestamp, sequenceChars, transformed) =>
        runtime?.onPtyData(id, data, timestamp, sequenceChars ?? data.length, transformed)
    })
  }

  // Why: batching PTY data into short flush windows cuts IPC round-trips from hundreds/sec to ~120/sec; keystroke echo/redraws bypass it below.
  type PendingPtyData = {
    data: string
    startSeq?: number
    rawLength?: number
    transformed?: true
    containsBackgroundOutput?: boolean
    // Why droppedOutput (not main's droppedBacklog trim): this branch's drop-to-sentinel + snapshot-restore supersedes #7630's 2MB-tail trim; both would race two cap policies over one buffer.
    droppedOutput?: true
  }

  type PtyDataPayload = {
    id: string
    data: string
    seq?: number
    rawLength?: number
    transformed?: boolean
    background?: boolean
    droppedOutput?: boolean
  }

  const pendingData = new Map<string, PendingPtyData>()
  // Why: one restore marker per overflow episode — cleared on full drain so a later overflow re-marks exactly once.
  const pendingOverflowMarkedPtys = new Set<string>()
  // Why: TCP-style cumulative accounting — monotonic sent/acked totals self-heal on any later ACK, where relative in-flight counters would make each lost ACK a permanent debt.
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
  // Why 2ms: pairs with the daemon stream batcher (daemon-stream-data-batcher.ts); keeps flood coalescing at negligible IPC overhead while cutting the pipeline's latency tax.
  const PTY_BATCH_INTERVAL_MS = 2
  const PTY_BATCH_DRAIN_CONTINUE_MS = 1
  const PTY_BATCH_FLUSH_CHUNK_CHARS = 16 * 1024
  const PTY_BATCH_FLUSH_MAX_WRITES = 2
  const PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS = 512 * 1024
  const PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS = 8 * 1024 * 1024
  // Why: cap unbounded pendingData growth when the renderer can't receive (frozen/reloading); beyond it bytes drop and the pane heals from the main buffer snapshot via the droppedOutput sentinel (#7630).
  // Why read settings live: the cap scales with the user's scrollback so power users don't lose lines their scrollback would have retained.
  const pendingDataCapChars = (): number =>
    terminalOutputBacklogCapChars(getSettings?.().terminalScrollbackRows)
  // Why: self-heal bound — if a reloaded page never sends pty:rendererDispatcherReady, force sends on after this window so a lost handshake can't become a permanent hold.
  const PTY_DISPATCHER_READY_WATCHDOG_MS = 10_000
  const PTY_RENDERER_INTERACTIVE_RESERVE_CHARS = 256 * 1024
  // Why: reserve a bounded lane so an active pane's keystroke redraw reaches the renderer ahead of hidden bulk output's ACKs.
  const PTY_RENDERER_ACTIVE_PTY_IN_FLIGHT_RESERVE_CHARS = 512 * 1024
  // Why: request/response hygiene only (never mutates delivery state) — clears the outstanding-probe flag so a later arrival can re-probe, logs once per silent streak.
  const PTY_DELIVERY_RESYNC_TIMEOUT_MS = 5_000
  // Why: a heal write-off destroys delivery accounting; require this much main-side ACK silence (independent of renderer evidence) before declaring the channel dead.
  const PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS = 10_000
  // Why: keep the immediate path to keystroke-sized TUI redraws; large/non-interactive output must use the batcher.
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
  // Why: count of watchdog gate force-opens (no handshake arrived); nonzero flags a dropped-handshake self-heal.
  let rendererDispatcherReadyForcedCount = 0
  // Why: gate sends until the page's pty:data listener exists; else webContents.send drops bytes but still counts them in-flight, permanently pinning the gate.
  let rendererPtyDispatcherReady = false
  let dispatcherReadyWatchdogTimer: ReturnType<typeof setTimeout> | null = null

  // Why: watermark producer pause/resume keyed on per-PTY pendingData (in-flight is already ACK-bounded); providers without pauseProducer no-op, memory still bounded by the pending cap.
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

  // Why: hidden ptys are exempt from pendingData flow control, so background agents can run 100MB+ ahead in the daemon stream buffer; this sync tells the provider transport which ptys to keep-tail thin.
  // Why keyed on the visibility registry (not gate marks): thinning asks "does any visible view show this PTY?"; remote-view subscribers consume raw bytes, so their presence vetoes thinning.
  const backgroundedDeliverySyncByPty = new Map<string, boolean>()
  function syncPtyBackgroundedDelivery(id: string, caller: string): void {
    const background =
      rendererPtyIsKnownHidden(id) && !(runtime?.hasRawTerminalViewSubscriber?.(id) ?? false)
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
    // Why: a pty both hidden-gated and reported visible means main is starving a visible pane (v1.4.124-rc.2.perf field lead).
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

  // Built only when the debug snapshot is read (never on the data path): the per-pty table + breadcrumb history says WHICH pty is wedged and WHEN, unlike aggregate counters.
  function buildMainDeliveryDiagnostics(): PtyMainDeliveryDiagnostics {
    const now = Date.now()
    // Include hidden/visible/active members even without an accounting entry: a pty gated before its first byte is exactly the wedge case to surface.
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

  // Why rate-limited: the contradiction persists chunk after chunk while latched; one line per minute keeps field logs readable but present.
  let lastHiddenDropContradictionWarnAtMs = 0
  function warnIfDroppingHiddenBytesForVisiblePty(id: string, droppedChars: number): void {
    if (!visibleRendererPtys.has(id) && !activeRendererPtys.has(id)) {
      return
    }
    // Recorded before the warn rate limit: the ring coalesces repeats, and the contradiction must appear in the freeze report either way.
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
    // Why update peaks directly: this fires on every delivery event, so avoid allocating a full 13-field snapshot object per call (only needed when the debug getter is read).
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
    // Why derived per entry: this tracks cumulative sent/acked totals (TCP-style), not a per-pty in-flight map — in-flight is the difference.
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
    // Why lossless: pendingData bytes were bound for the dead page; the replacement repaints from main's authoritative sources, which superset it.
    lastLifecycleResetClearedChars = rendererInFlightTotalChars
    rendererLifecycleResetCount += 1
    // Why release before clearing: pending bytes and credits belonged to the dead page; releasing producer pauses first keeps no shell wedged.
    producerFlowControl.releaseAll()
    clearDeliveryResyncProbe()
    deliveryResyncUnansweredWarnLogged = false
    rendererDeliveryAccountingByPty.clear()
    rendererInFlightTotalChars = 0
    pendingData.clear()
    pendingOverflowMarkedPtys.clear()
    // Why hold sends: the reloading page's pty:data listener is gone until it re-registers/handshakes, so bytes would drop into a listener-less page and re-pin the gate.
    rendererPtyDispatcherReady = false
    // Why: arm the self-heal watchdog so a never-arriving handshake can't hold the gate forever; the real handshake cancels it.
    armDispatcherReadyWatchdog()
    recordPtyRendererDeliveryPressure()
  }
  // Why the bridge: let a later re-registration cancel this closure's watchdog (armed via a hoisted fn, so this assignment can precede its definition).
  clearRendererDispatcherReadyWatchdog = clearDispatcherReadyWatchdog

  function isLikelyInteractiveRedraw(data: string): boolean {
    if (data.length <= INTERACTIVE_OUTPUT_MAX_CHARS) {
      return true
    }
    // Why the ANSI check: Codex-style TUIs repaint >1 KB per keypress (latency-sensitive), while plain command output should stay on the throughput batch path.
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

  function makePtyDataPayload(
    id: string,
    data: string,
    startSeq: number | undefined,
    containsBackgroundOutput: boolean | undefined,
    rawLength = data.length,
    transformed = false
  ): PtyDataPayload {
    const payload: PtyDataPayload = { id, data }
    if (typeof startSeq === 'number') {
      payload.seq = startSeq + rawLength
    }
    if (typeof startSeq === 'number' || rawLength !== data.length || transformed) {
      payload.rawLength = rawLength
    }
    if (transformed) {
      payload.transformed = true
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
    // Why per-PTY (not global) reserve: keep one active pane responsive without letting every background pane burst past the cap.
    const ptyLimit =
      PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS +
      (options.interactive === true ? PTY_RENDERER_ACTIVE_PTY_IN_FLIGHT_RESERVE_CHARS : 0)
    return getRendererInFlightCharsForPty(id) < ptyLimit && rendererInFlightTotalChars < totalLimit
  }

  // Why max-merge cumulative totals: idempotent and reorder-tolerant — replayed/out-of-order ACKs can't double-credit and a lost ACK self-heals. Returns the newly acknowledged delta.
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

  // Why: data for a fully gated PTY signals delivery may be stuck on lost ACKs (e.g. dropped across suspend); ask the renderer for authoritative totals instead of a wall-clock guess.
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
      // Why no mutation on timeout: unanswered means dead IPC that only a reload cures; log once per silent streak to avoid spamming every probe.
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

  // Why write off: bytes sent but never received after a confirmed wedge are gone (no ACK can repay them); hand back restore markers so panes repaint from the snapshot.
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
      // Why skip: received-but-unparsed bytes are alive in the renderer write queue; their deferred ACK still repays this debt.
      if (receivedChars > accounting.ackedChars) {
        continue
      }
      const acknowledged = applyCumulativeAck(id, accounting.sentChars)
      if (acknowledged <= 0) {
        continue
      }
      tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
      // Why drop pending: everything at/before markerSeq comes from the snapshot, so flushing pre-marker bytes would double-paint the restore.
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

  // Why out-of-band (not pty:data): an in-band empty chunk is indistinguishable from one fully consumed by renderer-side OSC-9999 stripping, which spuriously restored visible panes.
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

  // Why capped: keeps O(1) memory per PTY; salvaged query bytes are tiny, so past the cap a pathological stream can degrade to the plain sentinel.
  const DROPPED_QUERY_SALVAGE_MAX_CHARS = 4096

  // Why carve out queries: a bulk drop must not swallow reply-eliciting probes (DSR/CPR, DA1/DA2, DECRQM, OSC 10/11) the program blocks on; snapshot heals content so replies can't double-fire.
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
      // Why: field visibility for cap tuning (issue #2836 / #7017); no pty id since session ids can embed workspace paths.
      recordCrashBreadcrumb('terminal_pending_output_dropped', {
        droppedChars: pending.data.length,
        capChars
      })
    }
    // Why the marker: the snapshot can recover the dropped middle; emit it once per overflow episode so a fresh or reloaded view latches restore too.
    if (isHiddenPtyDeliveryGateEnabled(getSettings?.()) && !pendingOverflowMarkedPtys.has(id)) {
      pendingOverflowMarkedPtys.add(id)
      sendModelRestoreNeededMarker(id, 'pending-cap', runtime?.getPtyOutputSequence(id))
    }
    pendingDroppedChars += pending.data.length
    // Why no trimmed content tail: a mid-stream gap would corrupt the pane; the droppedOutput sentinel repaints from the snapshot and realigns by sequence (only query bytes ride along).
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
    containsBackgroundOutput: boolean,
    rawLength = data.length,
    transformed = false
  ): PendingPtyData {
    // Why stay dropped at O(1): once over the cap the restore sentinel supersedes interim bytes; queries still get carved out (bounded) so replies survive the whole episode.
    if (existing?.droppedOutput === true) {
      if (existing.data.length >= DROPPED_QUERY_SALVAGE_MAX_CHARS) {
        return existing
      }
      const salvaged = extractDroppedPtyQueryBytes(data)
      return salvaged ? { ...existing, data: existing.data + salvaged } : existing
    }
    const nextContainsBackgroundOutput =
      existing?.containsBackgroundOutput === true || containsBackgroundOutput
    if (!existing) {
      return dropOversizedPendingPtyData(id, {
        data,
        ...(typeof startSeq === 'number' ? { startSeq } : {}),
        ...(rawLength !== data.length ? { rawLength } : {}),
        ...(transformed ? { transformed: true } : {}),
        ...(nextContainsBackgroundOutput ? { containsBackgroundOutput: true } : {})
      })
    }
    const existingRawLength = existing.rawLength ?? existing.data.length
    const next: PendingPtyData = {
      data: existing.data + data,
      ...(!preservesSeq || existing.transformed || transformed
        ? { rawLength: existingRawLength + rawLength, transformed: true as const }
        : {}),
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
    // Why: one-shot self-heal — force the gate open if the reloaded page never signals ready, so a dropped handshake can't hold it forever. Unref'd so it can't keep the process alive.
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
      // Why release now: bookkeeping is being wiped, so no future drain can resume these producers — local shells would wedge.
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
    // Why hold: the page's pty:data listener isn't registered yet; bytes accrue in pendingData (rebuilt losslessly) and the ready handshake reschedules this flush.
    if (!rendererPtyDispatcherReady) {
      return
    }
    const settings = getSettings?.()
    let writes = 0
    for (const [id, pending] of getPendingPtyFlushEntries()) {
      if (writes >= PTY_BATCH_FLUSH_MAX_WRITES) {
        break
      }
      // Why drop, never re-queue: the model already ingested hidden-gated bytes; reveal restores from the snapshot+seq machinery.
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
        // Why droppedOutput sentinel: pending-cap drop means the pane must repaint from the snapshot, not continue a gapped stream (data = carved query bytes only).
        sendPtyDataToRenderer(id, { id, data: pending.data, droppedOutput: true })
        writes++
        continue
      }
      const { data } = pending
      const indivisible = pending.transformed === true
      const chunk = indivisible ? data : data.slice(0, PTY_BATCH_FLUSH_CHUNK_CHARS)
      const remaining = indivisible ? '' : data.slice(PTY_BATCH_FLUSH_CHUNK_CHARS)
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
        makePtyDataPayload(
          id,
          chunk,
          pending.startSeq,
          pending.containsBackgroundOutput,
          pending.rawLength,
          pending.transformed
        )
      )
      writes++
    }
    if (pendingData.size > 0 && writes === 0) {
      ackGatedFlushSkipCount++
    }
    recordPtyRendererDeliveryPressure()
    if (pendingData.size > 0 && writes > 0) {
      // Why yield between slices: a background terminal can dump megabytes at once, and keystroke writes must not stall behind one flush.
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
  const reversibleStopOwnersByPtyId = new Map<string, number>()

  function rememberSyntheticKillExit(id: string): void {
    const existing = syntheticKillExitPtyIds.get(id)
    if (existing) {
      clearTimeout(existing)
    }
    // Why a timed window: providers may report the real exit after kill completes; skip only that late duplicate, not a future reused id forever.
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
    // Why flush before exit: the renderer tears down the terminal on pty:exit, so any batched output not yet flushed would be silently lost.
    const remaining = pendingData.get(payload.id)
    if (remaining) {
      if (remaining.droppedOutput === true) {
        // Sentinel entry: only salvaged query bytes remain; keep the flag so the renderer knows the span was dropped.
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
            remaining.containsBackgroundOutput,
            remaining.rawLength,
            remaining.transformed
          )
        )
      }
      pendingData.delete(payload.id)
    }
    // Why resume a dead PTY (no-op): avoid leaving a stale paused mark behind for a reused id.
    producerFlowControl.release(payload.id)
    pendingOverflowMarkedPtys.delete(payload.id)
    lastInputAtByPty.delete(payload.id)
    interactiveOutputCharsByPty.delete(payload.id)
    rendererInFlightTotalChars = Math.max(
      0,
      rendererInFlightTotalChars - getRendererInFlightCharsForPty(payload.id)
    )
    // Why: the renderer also drops its cumulative total on pty:exit, so a reused id restarts aligned at zero on both sides.
    rendererDeliveryAccountingByPty.delete(payload.id)
    recordPtyRendererDeliveryPressure()
    mainWindow.webContents.send('pty:exit', {
      ...payload,
      ...(reversibleStopOwnersByPtyId.has(payload.id) ? { preserveRendererBinding: true } : {})
    })
  }

  async function shutdownProviderAndDetectExit(
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<boolean> {
    let providerExitObserved = false
    const expectedIncarnationId = ptyIncarnationById.get(id)
    const unsubscribe = provider.onExit((payload) => {
      if (
        payload.id === id &&
        (!expectedIncarnationId || payload.incarnationId === expectedIncarnationId)
      ) {
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

  // Why extracted: the "Restart daemon" flow rebinds against the fresh adapter after replaceDaemonProvider, sharing this code path with startup registration.
  const bindProviderListeners = (): void => {
    localDataUnsub?.()
    localExitUnsub?.()
    localBackgroundStreamUnsub?.()

    // Daemon keep-tail thinning facts, in byte order with onData: markers flip transient-fact scan authority; a gap forces renderer restore from the snapshot.
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

    // Why: daemon providers lack configure().onData, so feed the runtime here or their tail buffer (terminal.read, agent-detection, mobile stream) stays empty.
    const isLocalProvider = localProvider instanceof LocalPtyProvider

    localDataUnsub = localProvider.onData((payload) => {
      const rawLength = payload.sequenceChars ?? payload.data.length
      const outputSeq = isLocalProvider
        ? runtime?.getPtyOutputSequence(payload.id)
        : runtime?.onPtyData(payload.id, payload.data, Date.now(), rawLength, payload.transformed)
      const rendererData = payload.data
      const preservesSeq = !payload.transformed && rawLength === payload.data.length
      const startSeq =
        typeof outputSeq === 'number' ? Math.max(0, outputSeq - rawLength) : undefined
      if (mainWindow.isDestroyed()) {
        // Why clear the flush timer: macOS app re-activation otherwise leaks orphaned timers from the previous window's registration.
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
      // Why drop before the interactive bypass: runtime already ingested the chunk, so gated PTYs skip both renderer paths and reveal restores from the snapshot.
      if (shouldDropHiddenRendererPtyData(payload.id, settings)) {
        const drop = recordHiddenRendererPtyDataDrop(payload.id, payload.data.length)
        warnIfDroppingHiddenBytesForVisiblePty(payload.id, payload.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(payload.id, 'hidden-drop', outputSeq)
        }
        return
      }
      if (rendererData.length === 0 && !payload.transformed) {
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
        containsBackgroundOutput,
        rawLength,
        payload.transformed === true
      )
      const nextData = pending.data
      const isInteractiveOutput = shouldSendInteractiveOutputNow(
        payload.id,
        nextData,
        performance.now()
      )
      // Why gate the fast path on the handshake too: else boot-window keystroke echo is sent into a listener-less page and pins the gate.
      if (isInteractiveOutput && rendererPtyDispatcherReady) {
        // Why the reserve: keep input echo from being pinned behind unrelated bulk output; it's bounded and the per-PTY cap still prevents an active TUI runaway.
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
        // Why immediate: agent TUIs redraw small prompt regions per keystroke; the throughput batch timer would add visible input latency.
        sendPtyDataToRenderer(payload.id, {
          id: payload.id,
          data: nextData,
          ...(typeof pending.startSeq === 'number'
            ? {
                seq: pending.startSeq + (pending.rawLength ?? nextData.length),
                rawLength: pending.rawLength ?? nextData.length
              }
            : {}),
          ...(pending.transformed ? { transformed: true } : {}),
          ...(pending.containsBackgroundOutput === true ? { background: true } : {}),
          ...(pending.droppedOutput === true ? { droppedOutput: true } : {})
        })
        return
      }
      pendingData.set(payload.id, pending)
      updateProducerFlowControl(payload.id)
      recordPtyRendererDeliveryPressure()
      // Why probe on data arrival (not flush skips): new output for a fully gated PTY is the moment stuck delivery becomes observable.
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
      if (!isCurrentPtyExit(payload)) {
        return
      }
      if (consumeSyntheticKillExit(payload.id)) {
        return
      }
      if (!isLocalProvider) {
        clearProviderPtyState(payload.id)
        ptyOwnership.delete(payload.id)
        markClaudePtyExited(payload.id)
        runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId)
      }
      sendPtyExitToRenderer(payload)
    })
  }

  bindProviderListeners()
  rebindProviderListeners = bindProviderListeners

  // Why: one persistent listener with a request-ID dispatch table instead of one per call, so concurrent serialize requests don't trip Node's MaxListeners=10 warning.
  type SerializeResult = {
    data: string
    cols: number
    rows: number
    seq?: number
    lastTitle?: string
  } | null
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
          seq?: unknown
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
        const result: {
          data: string
          cols: number
          rows: number
          seq?: number
          lastTitle?: string
        } = {
          data: snapshot.data,
          cols: snapshot.cols,
          rows: snapshot.rows
        }
        if (typeof snapshot.seq === 'number' && Number.isFinite(snapshot.seq)) {
          result.seq = snapshot.seq
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

  // Why: reload/crash orphans delivery-interest holds and hidden marks; reset so surviving PTYs aren't stuck force-fed or gated — each pane's first sync re-marks.
  clearRendererGateResetHandlers()
  rendererGateResetLoadHandler = () => {
    resetRendererScopedHiddenPtyDeliveryState()
    // Why: the daemon pacer must not keep throttling ptys whose hidden marks died with the renderer; the fresh renderer's sync re-marks the still-hidden ones.
    resyncBackgroundedDeliveriesAfterGateReset()
  }
  rendererGateResetGoneHandler = () => {
    resetRendererScopedHiddenPtyDeliveryState()
    resyncBackgroundedDeliveriesAfterGateReset()
  }
  rendererGateResetWebContents = mainWindow.webContents
  mainWindow.webContents.on('did-finish-load', rendererGateResetLoadHandler)
  mainWindow.webContents.on('render-process-gone', rendererGateResetGoneHandler)

  // Why: only LocalPtyProvider PTYs (main-process) can be orphaned on reload; daemon sessions survive by design and cleanup would kill them.
  clearDidFinishLoadHandler()
  if (localProvider instanceof LocalPtyProvider) {
    const lp = localProvider
    didFinishLoadHandler = () => {
      // Why: always advance to keep the generation monotonic, but skip the sweep on crash/freeze-recovery reload — it would kill live local PTYs before session restore (#5787).
      const generation = lp.advanceGeneration()
      if (options?.isRecoveryReloadInFlight?.(mainWindow.webContents.id)) {
        return
      }
      // Why: the retained provider onExit callback is the only physical-exit proof; it clears ownership after the OS reaps it.
      lp.killOrphanedPtys(generation - 1)
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
    // Why: Win32 statSync on \\wsl.localhost 9P shares can falsely report ENOENT; defer to the provider's WSL-aware validation.
    if (isWslUncPath(path)) {
      return true
    }
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  const prepareCodexResumeHome = (args: {
    connectionId?: string | null
    launchAgent?: TuiAgent
    providerSession?: AgentProviderSessionMetadata
    target: CodexAccountSelectionTarget
    launchEnv?: NodeJS.ProcessEnv
    workspacePath?: string
  }): Promise<{ codexHomePath: string | null } | null> | null => {
    if (args.connectionId || args.launchAgent !== 'codex' || !options?.prepareCodexSessionResume) {
      return null
    }
    const providerSession = normalizeAgentProviderSession(args.providerSession)
    if (!providerSession) {
      return null
    }
    return options.prepareCodexSessionResume({
      providerSession,
      target: args.target,
      launchEnv: args.launchEnv,
      workspacePath: args.workspacePath
    })
  }

  // Why: route through getProviderForPty() so CLI commands work for remote PTYs too; localProvider would silently fail for them.
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
      // Why: runtime-created terminals carry no renderer-computed projectRuntime; resolve from worktreeId to honor the project's Windows runtime.
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
      const codexResumePreparation = prepareCodexResumeHome({
        connectionId: args.connectionId,
        launchAgent: args.launchAgent,
        providerSession: args.resumeProviderSession,
        target: codexSelectionTarget,
        launchEnv: args.env,
        workspacePath: cwd
      })
      const codexResumeHome = codexResumePreparation ? await codexResumePreparation : null
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
      const callerRequestedSessionId = args.sessionId?.trim()
      const requestedSessionId =
        callerRequestedSessionId ??
        (isDaemonHostSpawn && args.agentSessionCreateOperationId
          ? ptySessionIdForAgentCreateOperation(args.worktreeId, args.agentSessionCreateOperationId)
          : undefined)
      const sessionId =
        requestedSessionId ?? (isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
      const effectiveSessionRelayId =
        sessionId !== undefined ? getRelayPtyId(args.connectionId, sessionId) : undefined
      const effectiveSessionAppId =
        sessionId !== undefined ? getAppPtyId(args.connectionId, sessionId) : undefined
      const isMintedSessionId = callerRequestedSessionId === undefined && isDaemonHostSpawn
      const expectedWslDistro = !args.connectionId
        ? (resolveWslSessionContext({
            cwd,
            sessionId,
            shellOverride: terminalRuntimeOptions.shellOverride,
            terminalWindowsWslDistro: terminalRuntimeOptions.terminalWindowsWslDistro
          })?.distro ?? null)
        : null
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
            codexResumeHome
              ? codexResumeHome.codexHomePath
              : (getSelectedCodexHomePath?.(codexSelectionTarget, env, {
                  workspacePath: cwd,
                  launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
                }) ?? null)
          )
        : null
      const skipCodexHomeEnv =
        isDaemonHostSpawn &&
        shouldSkipCodexHomeEnvForWindowsShell(daemonShellOverride, cwd) &&
        !selectedCodexHomePath
      const stripInheritedOrcaCodexHome =
        isDaemonHostSpawn &&
        shouldStripInheritedOrcaCodexHome({
          target: codexSelectionTarget,
          selectedCodexHomePath,
          skipCodexHomeEnv,
          settings: getSettings?.()
        })
      if (isDaemonHostSpawn && sessionId) {
        if (!isSafePtySessionId(sessionId, app.getPath('userData'))) {
          throw new Error('Invalid PTY session id')
        }
        env = buildPtyHostEnv(sessionId, env ?? {}, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath,
          skipCodexHomeEnv,
          stripInheritedOrcaCodexHome,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false,
          launchCommand: args.command,
          launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
          shellPath: daemonShellOverride ?? process.env.COMSPEC,
          isWsl: shouldSkipCodexHomeEnvForWindowsShell(daemonShellOverride, cwd),
          wslDistro: codexSelectionTarget.runtime === 'wsl' ? codexSelectionTarget.wslDistro : null,
          agentStatusHooksEnabled: isAgentStatusHooksEnabled(getSettings?.()),
          networkProxySettings: getSettings?.(),
          deferGitConfigGuardToDaemon: provider.supportsGitCredentialGuardHost?.(sessionId) === true
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
      if (!isDaemonHostSpawn && codexResumeHome) {
        spawnOptions.codexHomePathOverride = { value: codexResumeHome.codexHomePath }
      }
      const startupTerminalColorQueryReplyColors = getStartupTerminalColorQueryReplyColors(args)
      if (startupTerminalColorQueryReplyColors) {
        spawnOptions.startupIngress = {
          colors: startupTerminalColorQueryReplyColors,
          deadlineMs: 5_000
        }
      }
      let ptySpawnCommitReported = false
      const reportPtySpawnCommitted = (): void => {
        if (ptySpawnCommitReported) {
          return
        }
        ptySpawnCommitReported = true
        args.onPtySpawnCommitted?.()
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
      } else if (stripInheritedOrcaCodexHome) {
        // Why: the daemon owns a persistent inherited environment that may
        // differ from main. ORCA_CODEX_HOME asks it to compare/delete the pair.
        spawnOptions.envToDelete = mergePtyEnvDeletions(spawnOptions.envToDelete, [
          'ORCA_CODEX_HOME'
        ])
      }
      if (codexResumeHome?.codexHomePath) {
        spawnOptions.envToDelete = removeCodexHomeDeletionRequests(spawnOptions.envToDelete)
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
      if (isTuiAgent(args.launchAgent)) {
        spawnOptions.launchAgent = args.launchAgent
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
      if (
        args.agentSessionEnsure &&
        (await (provider as IPtyProvider).supportsAgentSessionClaims?.()) === false
      ) {
        // Why: runtime routing must select legacy before dispatch; never downgrade here after it began.
        throw new Error('agent_session_claim_unavailable')
      }
      if (
        args.agentSessionCreateOperationId &&
        (await (provider as IPtyProvider).supportsAgentSessionCreateOperations?.()) === false
      ) {
        throw new Error('execution_owner_unavailable')
      }
      if (args.agentSessionEnsure) {
        spawnOptions.agentSessionEnsure = args.agentSessionEnsure
      }
      if (args.agentSessionCreateOperationId) {
        spawnOptions.agentSessionCreateOperationId = args.agentSessionCreateOperationId
      }
      if (args.signal) {
        spawnOptions.signal = args.signal
      }
      if (
        args.onPtySpawnCommitted &&
        (provider instanceof LocalPtyProvider || routesFreshSpawnsToLocalProvider(provider))
      ) {
        // Why: local fallback has no lower operation ledger, so commit must be reported at native spawn.
        spawnOptions.onPtySpawnCommitted = reportPtySpawnCommitted
      }

      const existingPaneSpawn = materializedPaneKey
        ? paneSpawnReservationsByPaneKey.get(materializedPaneKey)
        : undefined
      if (existingPaneSpawn) {
        return await existingPaneSpawn.promise
      }
      const finishTerminalInstall = beginPtySpawnForWorktree(
        args.worktreeId,
        cwd,
        args.connectionId
      )
      const paneSpawnReservation = materializedPaneKey
        ? reservePaneSpawn(materializedPaneKey)
        : null
      let result: PtySpawnResult
      let rejectedRegistrationCandidate: PtySpawnResult | null = null
      let pendingRegistrationPtyId: string | null = null
      let preparedProvisionalExecutionContext = false
      let releaseWorktreeSpawn: (() => void) | undefined
      try {
        releaseWorktreeSpawn = await runtime?.acquireWorktreeTerminalSpawn?.(args.worktreeId)
        try {
          if (args.preAllocatedHandle) {
            trustedTerminalHandleEnv.add(args.preAllocatedHandle)
          }
          const expectedPtyId = effectiveSessionAppId ?? sessionId
          if (expectedPtyId) {
            runtime?.beginPtyRegistration?.(expectedPtyId)
            pendingRegistrationPtyId = expectedPtyId
          }
          if (isDaemonHostSpawn && expectedPtyId) {
            preparedProvisionalExecutionContext =
              runtime?.preparePtyExecutionContext?.(expectedPtyId, expectedWslDistro, {
                resetIncarnation: isMintedSessionId,
                preserveExisting: !isMintedSessionId
              }) ?? false
          }
          const sequenceBeforeProviderSpawn = expectedPtyId
            ? (runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
            : 0
          const assertClientStillConnected = (): void => {
            if (args.signal?.aborted) {
              throw new Error('client_disconnected')
            }
          }
          if (args.agentSessionEnsure) {
            // Why: daemon-backed claims can outlive this controller; import all
            // proven owners before deciding that an identity is absent.
            await reconcileAgentSessionOwnerListings()
            const recoveredOwner = agentSessionOwners.find(args.agentSessionEnsure.claim)
            if (recoveredOwner && pendingRegistrationPtyId !== recoveredOwner.ptyId) {
              if (pendingRegistrationPtyId) {
                runtime?.cancelPendingPtyRegistration?.(pendingRegistrationPtyId)
              }
              runtime?.beginPtyRegistration?.(
                recoveredOwner.ptyId,
                ptyIncarnationById.get(recoveredOwner.ptyId)
              )
              pendingRegistrationPtyId = recoveredOwner.ptyId
            }
            let providerResult: PtySpawnResult | null = null
            const ensured = await agentSessionOwners.ensure({
              claim: args.agentSessionEnsure.claim,
              surface: args.agentSessionEnsure.surface,
              spawn: async () => {
                assertClientStillConnected()
                providerResult = await provider.spawn(spawnOptions)
                rejectedRegistrationCandidate = providerResult
                // Why: a successful lower-owner return proves physical work committed even if admission sees an early exit.
                reportPtySpawnCommitted()
                assertSpawnReplyWasLive(providerResult)
                runtime?.assertPtyRegistrationAllowed?.(
                  providerResult.id,
                  providerResult.incarnationId
                )
                if (providerResult.incarnationId) {
                  // Why: local providers cannot serialize controller claims, so liveness proof
                  // needs the exact incarnation before the registry promotes the new owner.
                  ptyIncarnationById.set(providerResult.id, providerResult.incarnationId)
                }
                const providerEnsure = providerResult.agentSessionEnsure
                return {
                  ptyId: providerResult.id,
                  ...(providerEnsure
                    ? {
                        owner: providerEnsure.owner,
                        disposition: providerEnsure.disposition
                      }
                    : {})
                }
              },
              isLive: async (owner) => {
                const ownerProvider = tryGetProviderForAgentSessionOwner(owner.ptyId)
                if (!ownerProvider) {
                  // Why: a disconnected relay may keep its PTY alive during the
                  // grace window; missing transport is unknown, never absence.
                  throw new Error('execution_owner_unavailable')
                }
                return await isProviderAgentSessionOwnerLive(ownerProvider, owner)
              }
            })
            result = providerResult ?? {
              id: ensured.owner.ptyId,
              isReattach: true,
              // Why: adoption from an authoritative listing must preserve the
              // incarnation proof used to reject a delayed exit from an older process.
              incarnationId: ptyIncarnationById.get(ensured.owner.ptyId)
            }
            result.agentSessionEnsure = ensured
          } else {
            assertClientStillConnected()
            result = await provider.spawn(spawnOptions)
            rejectedRegistrationCandidate = result
            // Why: daemon/relay returns cross the physical commit boundary before controller admission.
            reportPtySpawnCommitted()
            assertSpawnReplyWasLive(result)
          }
          rejectedRegistrationCandidate ??= result
          if (pendingRegistrationPtyId !== result.id) {
            if (pendingRegistrationPtyId) {
              runtime?.cancelPendingPtyRegistration?.(pendingRegistrationPtyId)
            }
            runtime?.beginPtyRegistration?.(result.id, result.incarnationId)
            pendingRegistrationPtyId = result.id
          }
          // Why: admission precedes sequence/context state and every durable publication below.
          runtime?.assertPtyRegistrationAllowed?.(result.id, result.incarnationId)
          if (result.providerSequence) {
            runtime?.synchronizePtyOutputSequenceFromProvider?.(
              result.id,
              result.providerSequence,
              sequenceBeforeProviderSpawn
            )
          }
          runtime?.preparePtyExecutionContext?.(
            result.id,
            args.connectionId
              ? null
              : result.wslDistro === undefined
                ? expectedWslDistro
                : result.wslDistro
          )
        } catch (err) {
          if ((isMintedSessionId || preparedProvisionalExecutionContext) && effectiveSessionAppId) {
            runtime?.preparePtyExecutionContext?.(effectiveSessionAppId, null, {
              resetIncarnation: true
            })
          }
          const rawMessage = err instanceof Error ? err.message : String(err)
          if (rawMessage === 'agent_session_exited_during_start' && rejectedRegistrationCandidate) {
            runtime?.releaseRejectedPtyRegistrationFence?.(
              rejectedRegistrationCandidate.id,
              rejectedRegistrationCandidate.incarnationId
            )
          }
          if (pendingRegistrationPtyId) {
            runtime?.cancelPendingPtyRegistration?.(
              pendingRegistrationPtyId,
              rejectedRegistrationCandidate?.incarnationId
            )
            pendingRegistrationPtyId = null
          }
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
        if (result.agentSessionEnsure?.disposition === 'adopted') {
          const owner = result.agentSessionEnsure.owner
          ptyOwnership.set(result.id, args.connectionId ?? ptyOwnership.get(result.id) ?? null)
          runtime?.registerPreAllocatedHandleForPty(result.id, owner.surface.terminalHandle)
          if (result.incarnationId) {
            ptyIncarnationById.set(result.id, result.incarnationId)
          }
          runtime?.registerPty(result.id, owner.surface.worktreeId, args.connectionId ?? null, {
            tabId: owner.surface.tabId,
            leafId: owner.surface.leafId,
            ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
          })
          return {
            id: result.id,
            ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
            agentSessionEnsure: result.agentSessionEnsure
          }
        }
        ptyOwnership.set(result.id, args.connectionId ?? null)
        if (result.incarnationId) {
          ptyIncarnationById.set(result.id, result.incarnationId)
        }
        // Why: record the native-Windows-local-PTY determination before any byte reaches the emulator, so its ConPTY DA1 override exists from byte zero.
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
          // Why: SSH leases keep relay ids for remote reconciliation, while session bindings keep app-facing ids for hydration.
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
              ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
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
            throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
              agentSessionOperationOutcome: 'unknown' as const
            })
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
            // Why: thread validated pane identity so main can back a pending mobile create even if graph-sync stalls (#7587).
            typeof args.tabId === 'string' &&
              isValidTerminalTabId(args.tabId) &&
              args.tabId.length <= 512 &&
              metadataLeafId !== null
              ? {
                  tabId: args.tabId,
                  leafId: metadataLeafId,
                  ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
                }
              : undefined,
            !args.connectionId
              ? shouldSkipCodexHomeEnvForWindowsShell(daemonShellOverride, cwd)
              : undefined
          )
        } else {
          // Why: non-worktree PTYs have no later surface-registration phase to clear admission intent.
          runtime?.cancelPendingPtyRegistration?.(result.id, result.incarnationId)
        }
        // Why: arms main's per-PTY Command Code output detector from the launch command (renderer startupCommand parity).
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
        // Why: runtime-owned CLI PTYs bypass the renderer pty:spawn handler; record paneKey here too since hook titles and cache cleanup need this reverse lookup.
        const paneKey = rememberPaneKeyForPty(result.id, env?.ORCA_PANE_KEY)
        const pendingSerializer = paneKey ? pendingByPaneKey.get(paneKey) : undefined
        const inheritRendererReadiness =
          result.isReattach === true &&
          !pendingSerializer &&
          rendererSerializerReadiness.has(result.id)
        rendererSerializerReadiness.beginIncarnation(result.id, inheritRendererReadiness)
        if (paneKey && pendingSerializer) {
          pendingPtyIdBySerializerGeneration.set(pendingSerializer.gen, result.id)
        }
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
        const response = {
          id: result.id,
          ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
          ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
        }
        return resolvePaneSpawnReservation(materializedPaneKey, paneSpawnReservation, response)
      } catch (err) {
        if (pendingRegistrationPtyId) {
          runtime?.cancelPendingPtyRegistration?.(
            pendingRegistrationPtyId,
            rejectedRegistrationCandidate?.incarnationId
          )
          pendingRegistrationPtyId = null
        }
        // Why: once the reservation is created, any later throw — spawn
        // failure, persist failure, or a post-spawn helper such as
        // registerPty/rememberPaneKeyForPty/track — must settle it. Otherwise
        // it lingers in paneSpawnReservationsByPaneKey and every future spawn
        // for this pane awaits a promise that never resolves. reject is a
        // no-op once the reservation has already resolved.
        rejectPaneSpawnReservation(materializedPaneKey, paneSpawnReservation, err)
        throw err
      } finally {
        releaseWorktreeSpawn?.()
        finishTerminalInstall()
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
      let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
      const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
      connectionId ??= parsedSshId?.connectionId
      const killWithCurrentProvider = (): boolean => {
        let provider: IPtyProvider
        try {
          provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
        } catch {
          if (connectionId) {
            // Why: runtime/CLI close can target a detached SSH PTY after its
            // provider was unregistered. Tombstone the lease so reconnect does
            // not revive a terminal the user explicitly closed.
            const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
            runtime?.onPtyExit(ptyId, -1, incarnationId)
            rememberSyntheticKillExit(ptyId)
            sendPtyExitToRenderer({ id: ptyId, code: -1 })
            return true
          }
          return false
        }
        // Why: controller is synchronous, but keep ownership until async shutdown proves whether the provider emitted an exit.
        void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
          .then((providerExitObserved) => {
            const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
            if (!providerExitObserved) {
              runtime?.onPtyExit(ptyId, -1, incarnationId)
              rememberSyntheticKillExit(ptyId)
              sendPtyExitToRenderer({ id: ptyId, code: -1 })
            }
          })
          .catch((err) => {
            if (isPtyAlreadyGoneError(err)) {
              const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
              runtime?.onPtyExit(ptyId, -1, incarnationId)
              rememberSyntheticKillExit(ptyId)
              sendPtyExitToRenderer({ id: ptyId, code: -1 })
              return
            }
            console.warn(
              `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
            )
            // Why: close runtime tails without clearing provider ownership, so
            // a retry can still target a PTY that survived the failed shutdown.
            runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
          })
        return true
      }
      const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
      if (startupPromise) {
        // Why: select the provider after the daemon swap; the fallback first can report success while orphaning a daemon PTY.
        void startupPromise.then(killWithCurrentProvider).catch((err) => {
          console.warn(
            `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
          )
          runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
        })
        return true
      }
      return killWithCurrentProvider()
    },
    markReversibleStops: (ptyIds) => {
      for (const ptyId of ptyIds) {
        reversibleStopOwnersByPtyId.set(ptyId, (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) + 1)
      }
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        for (const ptyId of ptyIds) {
          const owners = (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) - 1
          if (owners > 0) {
            reversibleStopOwnersByPtyId.set(ptyId, owners)
          } else {
            reversibleStopOwnersByPtyId.delete(ptyId)
          }
        }
      }
    },
    stopAndWait: async (ptyId, opts) => {
      let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
      const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
      connectionId ??= parsedSshId?.connectionId
      // Why: destructive teardown threads one absolute deadline through every await
      // below; each RPC leaf converts it to the remaining time when it issues, so
      // sequential RPCs share the budget and cannot overrun the sweep deadline.
      const deadlineMs = opts?.deadlineMs
      const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
      if (startupPromise) {
        // Why: exact-stop must resolve the provider after daemon startup just
        // like renderer kills, or the fallback can falsely confirm teardown.
        if (deadlineMs !== undefined) {
          // Why: bound the cold-start await by the teardown deadline instead of the
          // 60s startup fail-open cap; fail closed so the sweep records the miss.
          const won = await Promise.race([
            // Why: () => false on rejection both fails closed on a startup error and
            // keeps the losing branch's rejection from surfacing as unhandled.
            startupPromise.then(
              () => true,
              () => false
            ),
            delay(Math.max(1, deadlineMs - Date.now())).then(() => false)
          ])
          if (!won) {
            return false
          }
        } else {
          await startupPromise
        }
      }
      let provider: IPtyProvider
      try {
        provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
      } catch {
        if (connectionId) {
          // Why: an absent SSH provider means there is no live target left to
          // await, but the relay lease must still be tombstoned.
          const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
          runtime?.onPtyExit(ptyId, -1, incarnationId)
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
          keepHistory: opts?.keepHistory ?? false,
          deadlineMs
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
      const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
      if (!providerExitObserved) {
        runtime?.onPtyExit(ptyId, -1, incarnationId)
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
      // Why: desktop xterm and daemon/SSH providers hold separate buffers; clear both so mobile resubscribe can't resurrect cleared history.
      mainWindow.webContents.send('pty:clearBuffer:request', { ptyId })
      try {
        await getProviderForPty(ptyId).clearBuffer(ptyId)
      } catch {
        /* best effort: renderer clear still handles local PTYs */
      }
    },
    hasPty: (ptyId) => {
      try {
        return getProviderForPty(ptyId).hasPty?.(ptyId) ?? null
      } catch {
        return null
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
      // Why: mobile xterm must start from the desktop's exact screen state/dimensions before live TUI chunks render correctly.
      return requestSerializedBuffer(ptyId, opts)
    },
    serializeProviderBuffer: async (ptyId, opts) => {
      try {
        // Why: restored daemon PTYs can be live while their desktop pane is unmounted; query the provider model so phone-local navigation works.
        return (await getProviderForPty(ptyId).getBufferSnapshot?.(ptyId, opts)) ?? null
      } catch {
        return null
      }
    },
    hasRendererSerializer: (ptyId) => {
      // Why: a synchronous probe lets the runtime decide whether to skip the daemon-snapshot seed (renderer will hydrate) or run it (no renderer authoritative).
      return rendererSerializerReadiness.has(ptyId)
    },
    getRendererSerializerGeneration: (ptyId) => {
      return rendererSerializerReadiness.generation(ptyId)
    },
    waitForRendererSerializer: (ptyId, afterGeneration, timeoutMs, signal) => {
      return rendererSerializerReadiness.wait(ptyId, afterGeneration, timeoutMs, signal)
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
        // Why: after a data gap main holds only the retained tail; returning it as a full snapshot would erase older scrollback.
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
        // Why: the renderer's post-restore dedupe needs this pending-queue bound, or a stale baseline swallows new chunks whose seq sits below the snapshot counter.
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

  // Why: main owns side effects, so this replay restores title state only — never historical bells/completions (no-attention-replay rule, terminal-side-effect-authority.md).
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
        // Why: fresh local spawns opt into recovering a saved cwd whose dir was deleted (#7239); reattach/remote need exact cwd, so the flag alone isn't sufficient.
        cwdFallback?: 'worktree'
        env?: Record<string, string>
        envToDelete?: string[]
        command?: string
        commandDelivery?: 'renderer' | 'provider'
        launchConfig?: SleepingAgentLaunchConfig
        resumeProviderSession?: AgentProviderSessionMetadata
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
        // Why: hidden-at-spawn declaration (terminal-query-authority.md §races) — main marks hidden before byte zero so the gate owns spawn-time queries.
        initiallyHidden?: boolean
        // Why: closes the SIGKILL race (INVESTIGATION.md) by letting main sync-flush the binding before pty:spawn returns; only the Ctrl+T daemon-host path threads these.
        tabId?: string
        leafId?: string
        // Why: renderer-threaded launch telemetry (telemetry-plan.md§Agent launch semantics); loosely typed because the main-side schema validator is the single enforcement point.
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
      // Why: honor the fallback only for fresh local spawns — reattach needs exact cwd and SSH can't probe the local filesystem.
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
      // Why: the daemon-backed provider skips LocalPtyProvider's buildSpawnEnv, so assemble the same host-local env here for parity.
      // Safety: skip entirely for SSH — every injection is a loopback secret or a local path that leaks or misleads on the remote host.
      const isDaemonHostSpawn =
        !args.connectionId &&
        !(provider instanceof LocalPtyProvider) &&
        !routesFreshSpawnsToLocalProvider(provider)
      // Why: daemon host-env setup needs a stable id BEFORE provider.spawn so buildPtyHostEnv hooks/Pi cleanup can run; daemon still honors opts.sessionId ?? mint().
      // Note: sessionId is STABLE across daemon restarts by design — do NOT simplify to a fresh UUID per spawn; that orphans reconnectable state.
      // Why: only clear ids minted in THIS request on failure — a caller-supplied args.sessionId may name an existing PTY we must not clobber.
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
      const expectedWslDistro = !args.connectionId
        ? (resolveWslSessionContext({
            cwd,
            sessionId: effectiveSessionId,
            shellOverride: terminalRuntimeOptions.shellOverride,
            terminalWindowsWslDistro: terminalRuntimeOptions.terminalWindowsWslDistro
          })?.distro ?? null)
        : null
      const startupTerminalColorQueryReplyColors = getStartupTerminalColorQueryReplyColors(args)
      // Why: forward pane env to SSH only when the relay hook path is enabled, or a newer relay could emit statuses this build can't route.
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
        // Why: Agent Teams ids/tokens are process-local, so the team env must be regenerated for the new leader PTY.
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
        // Why: ORCA_PANE_KEY crosses into shells/hook registries; only a key proven to match this spawn's tab+leaf may cross the IPC boundary.
        delete baseEnv.ORCA_PANE_KEY
        delete baseEnv.ORCA_TAB_ID
        delete baseEnv.ORCA_WORKTREE_ID
        delete baseEnv.ORCA_AGENT_LAUNCH_TOKEN
      }
      const validatedPaneKey = stablePaneKey
      // Why: SSH can strip ORCA_PANE_KEY when remote hooks are off; IPC tab/leaf metadata still names the pane.
      const reservationPaneKey = metadataPaneKey ?? validatedPaneKey
      const validatedLeafId = verifiedLeafId ?? metadataLeafId
      let env: Record<string, string> | undefined = baseEnv
      const effectiveShellOverride = terminalRuntimeOptions.shellOverride
      const nativeWindowsConptySpawn = isNativeWindowsLocalPtySpawn({
        connectionId: args.connectionId,
        cwd: args.cwd,
        shellOverride: effectiveShellOverride
      })
      const codexSelectionTarget = getCodexSelectionTargetForPty(
        effectiveShellOverride,
        cwd,
        terminalRuntimeOptions.terminalWindowsWslDistro ?? null
      )
      const codexResumePreparation = prepareCodexResumeHome({
        connectionId: args.connectionId,
        launchAgent: args.launchAgent,
        providerSession: args.resumeProviderSession,
        target: codexSelectionTarget,
        launchEnv: baseEnv,
        workspacePath: cwd
      })
      const codexResumeHome = codexResumePreparation ? await codexResumePreparation : null
      const selectedCodexHomePath = isDaemonHostSpawn
        ? getCompatibleSelectedCodexHomePath(
            codexSelectionTarget,
            codexResumeHome
              ? codexResumeHome.codexHomePath
              : (getSelectedCodexHomePath?.(codexSelectionTarget, baseEnv, {
                  workspacePath: cwd,
                  launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
                }) ?? null)
          )
        : null
      const skipCodexHomeEnv =
        isDaemonHostSpawn &&
        shouldSkipCodexHomeEnvForWindowsShell(effectiveShellOverride, cwd) &&
        !selectedCodexHomePath
      const stripInheritedOrcaCodexHome =
        isDaemonHostSpawn &&
        shouldStripInheritedOrcaCodexHome({
          target: codexSelectionTarget,
          selectedCodexHomePath,
          skipCodexHomeEnv,
          settings: getSettings?.()
        })
      if (isDaemonHostSpawn) {
        if (effectiveSessionId === undefined) {
          // Should be unreachable: effectiveSessionId is a string when isDaemonHostSpawn; defense-in-depth.
          throw new Error('Invariant violation: daemon spawn without sessionId')
        }
        const sessionIdForEnv = effectiveSessionId
        // Why: this id reaches filesystem paths; reject traversal/separators so a crafted IPC payload can't escape the expected roots.
        if (!isSafePtySessionId(sessionIdForEnv, app.getPath('userData'))) {
          throw new Error('Invalid PTY session id')
        }
        // Why: clone before mutating so injections don't leak back into args.env (renderer may reuse it).
        env = { ...baseEnv }
        try {
          buildPtyHostEnv(sessionIdForEnv, env, {
            isPackaged: app.isPackaged,
            userDataPath: app.getPath('userData'),
            selectedCodexHomePath,
            skipCodexHomeEnv,
            stripInheritedOrcaCodexHome,
            githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false,
            launchCommand: args.command,
            launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
            shellPath: effectiveShellOverride ?? process.env.COMSPEC,
            isWsl: shouldSkipCodexHomeEnvForWindowsShell(effectiveShellOverride, cwd),
            wslDistro:
              codexSelectionTarget.runtime === 'wsl' ? codexSelectionTarget.wslDistro : null,
            agentStatusHooksEnabled: isAgentStatusHooksEnabled(getSettings?.()),
            networkProxySettings: getSettings?.(),
            deferGitConfigGuardToDaemon:
              provider.supportsGitCredentialGuardHost?.(effectiveSessionId) === true
          })
          promoteAgentTeamsShimPath(env, requestedAgentTeamsPath)
        } catch (err) {
          // Why: buildPtyHostEnv has fs side-effects (Pi/OMP install); clear per-PTY state on throw, but only minted ids — caller ids may name existing PTYs.
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
      let combinedEnvToDelete = mergePtyEnvDeletions(
        mergePtyEnvDeletions(
          mergePtyEnvDeletions(
            mergePtyEnvDeletions(
              mergePtyEnvDeletions(envToDelete, args.envToDelete ?? []),
              agentTeamsEnvToDelete ?? []
            ),
            isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(spawnEnv) : []
          ),
          skipCodexHomeEnv ? CODEX_HOME_ENV_KEYS : []
        ),
        // Why: the persistent daemon compares its own merged CODEX_HOME pair;
        // main cannot safely decide ownership for a process it may not parent.
        stripInheritedOrcaCodexHome ? ['ORCA_CODEX_HOME'] : []
      )
      if (codexResumeHome?.codexHomePath) {
        combinedEnvToDelete = removeCodexHomeDeletionRequests(combinedEnvToDelete)
      }
      deleteRequestedEnvKeys(spawnEnv, combinedEnvToDelete)
      promoteAgentTeamsShimPath(spawnEnv, requestedAgentTeamsPath)
      const spawnOptions: PtySpawnOptions = {
        cols: args.cols,
        rows: args.rows,
        cwd,
        env: spawnEnv,
        ...(isMintedSessionId ? { isNewSession: true } : {})
      }
      if (!isDaemonHostSpawn && codexResumeHome) {
        spawnOptions.codexHomePathOverride = { value: codexResumeHome.codexHomePath }
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
      // Why: without this, the Windows daemon path ignores the user's Default Shell preference (LocalPtyProvider already honors it via getWindowsShell()).
      if (effectiveShellOverride !== undefined) {
        spawnOptions.shellOverride = effectiveShellOverride
      }
      const hadSessionSizeBeforeAttach =
        effectiveSessionAppId !== undefined ? ptySizes.has(effectiveSessionAppId) : false
      const sessionSizeBeforeAttach =
        effectiveSessionAppId !== undefined ? ptySizes.get(effectiveSessionAppId) : undefined
      if (effectiveSessionId !== undefined) {
        // Why: daemon PTYs can emit before spawn() resolves; set real geometry now or early bytes default to 80x24 and wrap TUIs.
        ptySizes.set(effectiveSessionAppId ?? effectiveSessionId, {
          cols: args.cols,
          rows: args.rows
        })
      }
      if (process.platform === 'win32' && !args.connectionId) {
        // Why: the renderer models PowerShell as one shell family; thread the implementation choice so both PTY paths resolve the same executable.
        spawnOptions.terminalWindowsWslDistro =
          terminalRuntimeOptions.terminalWindowsWslDistro ?? null
        spawnOptions.terminalWindowsPowerShellImplementation = getSettings
          ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
          : undefined
      }
      if (startupTerminalColorQueryReplyColors) {
        spawnOptions.startupIngress = {
          colors: startupTerminalColorQueryReplyColors,
          deadlineMs: 5_000
        }
      }
      const existingPaneSpawn = reservationPaneKey
        ? paneSpawnReservationsByPaneKey.get(reservationPaneKey)
        : undefined
      if (existingPaneSpawn) {
        return await existingPaneSpawn.promise
      }
      const finishTerminalInstall = beginPtySpawnForWorktree(
        args.worktreeId,
        cwd,
        args.connectionId
      )
      const paneSpawnReservation = reservationPaneKey ? reservePaneSpawn(reservationPaneKey) : null
      const initiallyHidden = args.initiallyHidden === true
      // Why: daemon PTYs can emit before spawn() resolves, so the hidden mark must beat byte zero (terminal-query-authority.md §races); other providers are safe with the post-spawn mark below.
      const preSpawnHiddenMarkId =
        initiallyHidden && isDaemonHostSpawn && effectiveSessionAppId !== undefined
          ? effectiveSessionAppId
          : null
      if (preSpawnHiddenMarkId !== null) {
        markHiddenRendererPty(preSpawnHiddenMarkId)
      }
      let result: PtySpawnResult
      let rejectedRegistrationCandidate: PtySpawnResult | null = null
      let pendingRegistrationPtyId: string | null = null
      let preparedProvisionalExecutionContext = false
      let releaseWorktreeSpawn: (() => void) | undefined
      try {
        releaseWorktreeSpawn = await runtime?.acquireWorktreeTerminalSpawn?.(args.worktreeId)
        try {
          if (preAllocatedHandle) {
            trustedTerminalHandleEnv.add(preAllocatedHandle)
          }
          spawnTiming.mark('options')
          const expectedPtyId = effectiveSessionAppId ?? effectiveSessionId
          if (expectedPtyId) {
            runtime?.beginPtyRegistration?.(expectedPtyId)
            pendingRegistrationPtyId = expectedPtyId
          }
          if (isDaemonHostSpawn && expectedPtyId) {
            preparedProvisionalExecutionContext =
              runtime?.preparePtyExecutionContext?.(expectedPtyId, expectedWslDistro, {
                resetIncarnation: isMintedSessionId,
                preserveExisting: !isMintedSessionId
              }) ?? false
          }
          const sequenceBeforeProviderSpawn = expectedPtyId
            ? (runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
            : 0
          result = await provider.spawn(spawnOptions)
          rejectedRegistrationCandidate = result
          if (pendingRegistrationPtyId !== result.id) {
            if (pendingRegistrationPtyId) {
              runtime?.cancelPendingPtyRegistration?.(pendingRegistrationPtyId)
            }
            runtime?.beginPtyRegistration?.(result.id, result.incarnationId)
            pendingRegistrationPtyId = result.id
          }
          assertSpawnReplyWasLive(result)
          runtime?.assertPtyRegistrationAllowed?.(result.id, result.incarnationId)
          if (result.providerSequence) {
            runtime?.synchronizePtyOutputSequenceFromProvider?.(
              result.id,
              result.providerSequence,
              sequenceBeforeProviderSpawn
            )
          }
          runtime?.preparePtyExecutionContext?.(
            result.id,
            args.connectionId
              ? null
              : result.wslDistro === undefined
                ? expectedWslDistro
                : result.wslDistro
          )
          spawnTiming.mark('provider_spawn')
        } catch (err) {
          if ((isMintedSessionId || preparedProvisionalExecutionContext) && effectiveSessionAppId) {
            runtime?.preparePtyExecutionContext?.(effectiveSessionAppId, null, {
              resetIncarnation: true
            })
          }
          // Why: a stale hidden mark on this session id would gate a later visible attach that reuses it.
          if (preSpawnHiddenMarkId !== null) {
            unmarkHiddenRendererPty(preSpawnHiddenMarkId)
          }
          const rawMessage = err instanceof Error ? err.message : String(err)
          if (rawMessage === 'agent_session_exited_during_start' && rejectedRegistrationCandidate) {
            runtime?.releaseRejectedPtyRegistrationFence?.(
              rejectedRegistrationCandidate.id,
              rejectedRegistrationCandidate.incarnationId
            )
          }
          if (pendingRegistrationPtyId) {
            runtime?.cancelPendingPtyRegistration?.(
              pendingRegistrationPtyId,
              rejectedRegistrationCandidate?.incarnationId
            )
            pendingRegistrationPtyId = null
          }
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
            // Why: expired remote reattach = relay already dropped the PTY; clear the lease so writes can't restore the stale binding.
            if (effectiveSessionAppId !== undefined && !isIdentityMismatch) {
              clearProviderPtyState(effectiveSessionAppId)
              deletePtyOwnership(effectiveSessionAppId)
            }
            if (!isIdentityMismatch) {
              store?.markSshRemotePtyLease(args.connectionId, effectiveSessionRelayId, 'expired')
            }
          }
          // Why: provider state buildPtyHostEnv materialized for this minted id leaks if spawn failed.
          if (isMintedSessionId && effectiveSessionId !== undefined) {
            clearProviderPtyState(effectiveSessionId)
          }
          // Why: telemetry-plan.md§agent_error — attribute the error to the renderer-threaded agent_kind, else sniff the command for `claude`; raw messages are dropped at the validator boundary.
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
        if (result.incarnationId) {
          ptyIncarnationById.set(result.id, result.incarnationId)
        }
        if (initiallyHidden) {
          // Why marked synchronously here: provider data events dispatch on later tasks, so this still lands ahead of the first byte's delivery decision (idempotent if already marked pre-spawn).
          markHiddenRendererPty(result.id)
          if (preSpawnHiddenMarkId !== null && preSpawnHiddenMarkId !== result.id) {
            // Defense: never strand a mark on an id the provider renamed.
            unmarkHiddenRendererPty(preSpawnHiddenMarkId)
          }
          // Why after ptyOwnership.set: provider lookup routes by ownership, and a hidden-spawned agent should be paceable from its first flood.
          syncPtyBackgroundedDelivery(result.id, 'spawn')
          closeStartupQueryAuthorityForPty(result.id)
        }
        // Why: record the native-Windows-ConPTY determination before the headless seed so the emulator's DA1 override exists from byte zero.
        if (nativeWindowsConptySpawn) {
          markNativeWindowsConptyPty(result.id)
        }
        const relayResultId = getRelayPtyId(args.connectionId, result.id)
        if (store && args.connectionId) {
          // Why: remote PTYs live in the SSH relay grace window after Orca detaches; persist IDs immediately so reconnect reattaches instead of spawning a fresh shell.
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
        // Why: patch the load-bearing ptyId binding synchronously so a force-quit in the renderer's ~450 ms debounce window can't orphan daemon history or an SSH relay lease (Issue #217).
        if (
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
              ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
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
            throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
              agentSessionOperationOutcome: 'unknown' as const
            })
          }
        }
        // Why: when the renderer has declared it will own the serializer for this paneKey, suppress the daemon-snapshot seed so its hydration path is sole authority (keyed on paneKey since the ptyId isn't known yet). See docs/mobile-prefer-renderer-scrollback.md.
        const rendererPreSignaled = validatedPaneKey
          ? pendingByPaneKey.has(validatedPaneKey)
          : false
        const rendererAlreadyRegistered =
          result.isReattach === true &&
          !rendererPreSignaled &&
          rendererSerializerReadiness.has(result.id)
        rendererSerializerReadiness.beginIncarnation(result.id, rendererAlreadyRegistered)
        // Why: capture the pending gen at spawn time so this PTY's teardown only settles its own generation, not a remount that replaced the entry.
        if (validatedPaneKey && rendererPreSignaled) {
          const pending = pendingByPaneKey.get(validatedPaneKey)
          if (pending) {
            pendingPtyIdBySerializerGeneration.set(pending.gen, result.id)
          }
        }

        // Why: seed the headless emulator before registerPty so concurrent live PTY data lands on top of the seed, not replacing it (mobile keeps the daemon-restored scrollback).
        // Skip when the renderer will be authoritative — its xterm buffer is richer than the daemon snapshot.
        if (runtime && !rendererPreSignaled && !rendererAlreadyRegistered) {
          const snapshotSeedSize =
            typeof result.snapshotCols === 'number' && typeof result.snapshotRows === 'number'
              ? { cols: result.snapshotCols, rows: result.snapshotRows }
              : undefined
          if (typeof result.snapshot === 'string' && result.snapshot.length > 0) {
            // Why kitty flags ride seed metadata: the snapshot omits them, but the re-seeded emulator must answer hidden `CSI ? u` with the running app's flags (terminal-query-authority.md).
            runtime.seedHeadlessTerminal(
              result.id,
              result.snapshot,
              snapshotSeedSize,
              typeof result.snapshotKittyKeyboardFlags === 'number'
                ? { kittyKeyboardFlags: result.snapshotKittyKeyboardFlags }
                : {}
            )
          } else if (
            result.coldRestore &&
            typeof result.coldRestore.scrollback === 'string' &&
            result.coldRestore.scrollback.length > 0
          ) {
            const coldRestoreSeedSize =
              typeof result.coldRestore.cols === 'number' &&
              typeof result.coldRestore.rows === 'number'
                ? { cols: result.coldRestore.cols, rows: result.coldRestore.rows }
                : undefined
            runtime.seedHeadlessTerminal(
              result.id,
              result.coldRestore.scrollback,
              coldRestoreSeedSize,
              {
                cwd: result.coldRestore.cwd,
                oscLinks: result.coldRestore.oscLinks,
                preferProviderIfExisting: true
              }
            )
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
            // Why: pass validated pane identity so a throttled mobile create publishes its surface main-side instead of destroying the live PTY (#7587); bound the untrusted tabId.
            typeof args.tabId === 'string' &&
              isValidTerminalTabId(args.tabId) &&
              args.tabId.length <= 512 &&
              metadataLeafId !== null
              ? {
                  tabId: args.tabId,
                  leafId: metadataLeafId,
                  ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
                }
              : undefined,
            !args.connectionId
              ? shouldSkipCodexHomeEnvForWindowsShell(effectiveShellOverride, cwd)
              : undefined
          )
          pendingRegistrationPtyId = null
        } else if (pendingRegistrationPtyId) {
          runtime?.cancelPendingPtyRegistration?.(pendingRegistrationPtyId, result.incarnationId)
          pendingRegistrationPtyId = null
        }
        // Why: arm main's per-PTY Command Code output detector from the launch command (startupCommand parity); banner detection covers PTYs without one.
        runtime?.noteTerminalSpawnCommand?.(
          result.id,
          typeof args.command === 'string' ? args.command : null
        )
        if (isClaudeLaunch) {
          markClaudePtySpawned(result.id)
        }
        // Why: record the paneKey mapping so clearProviderPtyState can clear the agent-hooks server's per-paneKey caches on exit.
        // Why: args.env is untrusted IPC JSON (type unenforced); bound the paneKey so malformed/oversized values can't pollute ptyPaneKey or clearPaneState.
        const rememberedPaneKey = validatedPaneKey
          ? rememberPaneKeyForPty(result.id, validatedPaneKey)
          : null
        if (legacySpawnPaneKey && migrationUnsupportedPaneKey) {
          agentHookServer.registerPaneKeyAlias(
            legacySpawnPaneKey.paneKey,
            migrationUnsupportedPaneKey,
            result.id,
            Date.now(),
            { authorityVerified: true }
          )
          clearMigrationUnsupportedPtysForPaneKey(migrationUnsupportedPaneKey)
        } else if (validatedPaneKey) {
          if (!result.isReattach) {
            clearMigrationUnsupportedPtysForPaneKey(validatedPaneKey)
          }
        }
        // Why: register only local PTYs with the memory collector — SSH PTYs run remotely and their process tree is invisible to our local `ps`.
        if (!args.connectionId) {
          // Why: record the spawn-result pid once here so the memory module needn't reach back into ipc/pty on a hot path (works for in-process and daemon-hosted PTYs).
          const spawnedPid = result.pid ?? null
          // Why: args.worktreeId/sessionId arrive as untrusted IPC strings (type unenforced at the boundary); bound them so malformed/oversized values can't pollute registerPty's maps.
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
        // Why: telemetry-plan.md§Agent launch semantics — fire agent_started only after spawn resolved; safeParse each field so a spoofed IPC payload can't poison the event (missing required field skips it).
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
          // Why: a daemon-retry race can surface isReattach even for a minted session id, and a reattach must never claim its cwd was remapped.
          ...(startupCwdFallback && !result.isReattach ? { startupCwdFallback } : {})
        }
        return resolvePaneSpawnReservation(reservationPaneKey, paneSpawnReservation, response)
      } catch (err) {
        if (pendingRegistrationPtyId) {
          runtime?.cancelPendingPtyRegistration?.(
            pendingRegistrationPtyId,
            rejectedRegistrationCandidate?.incarnationId
          )
          pendingRegistrationPtyId = null
        }
        // Why: once the reservation is created, any later throw —
        // spawn failure, persist failure, or a post-spawn helper such as
        // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
        // it lingers in paneSpawnReservationsByPaneKey and every future spawn
        // for this pane awaits a promise that never resolves. reject is a
        // no-op once the reservation has already resolved.
        rejectPaneSpawnReservation(reservationPaneKey, paneSpawnReservation, err)
        throw err
      } finally {
        releaseWorktreeSpawn?.()
        finishTerminalInstall()
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
    // Why: mobile-presence-lock defense-in-depth — the renderer's onData guard can let one keystroke slip during the state-flip lag, so catch it server-side. See docs/mobile-presence-lock.md.
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
    // Why: the ack infers Ctrl+C/Escape reached the local PTY; SSH providers are fire-and-forget relay notifications and can't truthfully acknowledge yet.
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
    // Why: two panes can mirror one PTY — never let a later no-op claim replace the in-flight resize that the following host input must await.
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

  // Why: resize is fire-and-forget — ipcMain.on (not .handle) halves IPC traffic by skipping the empty acknowledgement reply.
  ipcMain.removeAllListeners('pty:resize')
  ipcMain.on('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    // Why: after a desktop-fit override change the renderer's safeFit cascade re-measures ALL panes (background ones at full width), so suppress every pty:resize in this window to avoid corrupting PTY dimensions.
    if (runtime?.isResizeSuppressed()) {
      return
    }
    // Why: presence-lock defense-in-depth — while a phone or remote-desktop viewer drives the width, host-side resizes must not reach the PTY or its alt-screen grid garbles; load-bearing because the renderer mirror lags one IPC hop. See docs/mobile-presence-lock.md.
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
      // Why: alt-screen TUIs repaint on SIGWINCH; a hidden repaint read after switch-back must not masquerade as live output and overwrite the correctly-sized screen.
      pendingHiddenRendererResizeOutputPtys.add(args.id)
      deliveredHiddenRendererResizeOutputPtys.delete(args.id)
    } else if (visibleRendererPtys.has(args.id)) {
      // Why: after the stale hidden-resize repaint is observed, the renderer's visible resize pulse owns the next repaint.
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

  // Why: pty:reportGeometry is a measurement-only sibling of pty:resize — it refreshes the restore-target cache (never resizes) so mobile-fit hold learns real desktop dims even while resize is blocked. See docs/mobile-fit-hold.md.
  ipcMain.removeAllListeners('pty:reportGeometry')
  ipcMain.on('pty:reportGeometry', (_event, args: { id: string; cols: number; rows: number }) => {
    runtime?.recordRendererGeometry(args.id, args.cols, args.rows)
  })

  // Why: fire-and-forget — clears the DaemonPtyAdapter's sticky cold-restore cache after the renderer consumed it; no-op for non-daemon providers.
  ipcMain.on('pty:ackColdRestore', (_event, args: { id: string }) => {
    const provider = tryGetProviderForPty(args.id)
    if (provider && 'ackColdRestore' in provider && typeof provider.ackColdRestore === 'function') {
      provider.ackColdRestore(args.id)
    }
  })

  // Why: renderer ACKs bound main→renderer delivery without stopping PTY ingestion — agent/status consumers still see every chunk via the provider/runtime path.
  ipcMain.on(
    'pty:ackData',
    (_event, args: { id: string; charCount?: number; processedChars?: number }) => {
      lastAckReceivedAtMs = Date.now()
      // Why: a live ACK channel means a future unanswered probe is a fresh diagnostic event, not a continuation of the last silent streak.
      deliveryResyncUnansweredWarnLogged = false
      let acknowledged = 0
      if (typeof args.processedChars === 'number' && Number.isFinite(args.processedChars)) {
        acknowledged = applyCumulativeAck(args.id, Math.max(0, args.processedChars))
      } else {
        // Why: tolerate legacy per-chunk delta payloads — dev hot-reload can pair an old renderer with a new main.
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
      // Why max-merge: the renderer's cumulative totals are authoritative for what it processed, draining exactly the in-flight debt from lost ACKs.
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

  // Why invoke + renderer-initiated: the field wedge (v1.4.121-rc.0) kills every main→renderer push channel while invoke survives, so the resync rides here plus a write-off lane.
  ipcMain.handle(
    'pty:reportRendererDeliveryState',
    (_event, args: PtyRendererDeliveryStateReport): PtyRendererDeliveryHealthReply => {
      // Extra repair lane for the lost-ACK variant: identical max-merge to the resync response, so a heal is only reached when merging cannot drain.
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
      // Why the main-side ACK-silence check: requiring main to have also seen no ACK stops a buggy/foreign caller from writing off live delivery.
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

  // Why: renderer signals its pty:data listener is live; until then sends are held so boot-window bytes can't drop into a listener-less page and pin the gate.
  ipcMain.removeAllListeners('pty:rendererDispatcherReady')
  ipcMain.on('pty:rendererDispatcherReady', (event) => {
    // Why: the reconcile below destructively clears delivery accounting, so a straggler handshake from a dying window must not reset the new window.
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents)) {
      return
    }
    // Why: a handshake while the gate is already open means a page load whose lifecycle reset was missed; clear the dead page's stale accounting so it can't permanently gate survivors.
    if (rendererPtyDispatcherReady) {
      resetRendererDeliveryAccountingForLifecycleReset()
    }
    // Why: real handshake landed — cancel the self-heal watchdog so it can't later force-open the gate.
    clearDispatcherReadyWatchdog()
    rendererPtyDispatcherReady = true
    schedulePendingDataFlush(0)
  })

  ipcMain.removeAllListeners('pty:setActiveRendererPty')
  ipcMain.on('pty:setActiveRendererPty', (_event, args: { id: string; active: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Why: renderer scheduling hint only — active panes just get first chance at the bounded output reserve; reads/state/notifications continue for inactive terminals.
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
    // Why: data produced while no renderer can see this PTY must keep that origin through batching, even if the user switches back before the flush lands.
    rendererVisibilityKnownPtys.add(args.id)
    if (args.visible) {
      visibleRendererPtys.add(args.id)
      closeStartupQueryAuthorityForPty(args.id)
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
      closeStartupQueryAuthorityForPty(args.id)
      // Why: drop bytes queued for a newly hidden PTY instead of holding them under ACK starvation; reveal restores from the snapshot.
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
    // Why: a reload/remount may have replaced the view that latched restore-needed, so re-emit on unhide; a redundant replay is cheap/idempotent, a missed restore corrupts the pane.
    if (droppedWhileHidden) {
      sendModelRestoreNeededMarker(args.id, 'unhide', runtime?.getPtyOutputSequence(args.id))
    }
  })

  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Why validate-or-drop: a malformed palette gives a wrong color reply that breaks TUI theme detection worse than the silent-until-first-push default.
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
    // Why: any delivery interest suppresses the hidden-delivery gate (raw-byte consumers keep receiving while hidden); not synced to the daemon pacer so interest churn can't un-pace a flood.
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
    // Why: clear PTY-side state (ConPTY/daemon/SSH buffer) so the next prompt repaint doesn't land at a stale cursor row.
    tryGetProviderForPty(args.id)
      ?.clearBuffer(args.id)
      .catch(() => {})
    runtime?.clearHeadlessTerminalBuffer(args.id).catch(() => {})
  })

  ipcMain.handle('pty:kill', async (_event, args: { id: string; keepHistory?: boolean }) => {
    if (typeof args?.id !== 'string' || !args.id || args.id.startsWith('remote:')) {
      // Why: runtime terminal handles belong to terminal.close; unowned PTY routing could target the local provider.
      throw new Error('Invalid PTY provider id')
    }
    const ownedConnectionId = ptyOwnership.get(args.id)
    const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(args.id) : null
    const connectionId = ownedConnectionId ?? parsedSshId?.connectionId
    // Why: wait for daemon startup before selecting the local provider, else a fallback shutdown falsely succeeds and orphans a restored daemon PTY (#7742).
    const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
    if (startupPromise) {
      await startupPromise
    }
    const provider = connectionId ? sshProviders.get(connectionId) : tryGetProviderForPty(args.id)
    if (!provider && connectionId) {
      // Why: detached SSH PTYs intentionally keep ownership after their
      // provider is unregistered; hydrated app-scoped ids can also arrive
      // before ownership is rebuilt. Tombstone instead of falling back local.
      const incarnationId = finishPtyShutdown(args.id, connectionId, store)
      runtime?.onPtyExit(args.id, -1, incarnationId)
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
        // Why: a failed shutdown can leave the process alive (SSH relay grace window / local daemon); keep ownership/lease state so the user can retry.
        throw err
      }
      /* session already dead — cleanup below handles the rest */
    }
    // Why: some shutdown paths do not emit onExit through the provider listener.
    // Explicit cleanup is idempotent and covers already-dead PTYs.
    const incarnationId = finishPtyShutdown(args.id, connectionId, store)
    if (!providerExitObserved) {
      runtime?.onPtyExit(args.id, -1, incarnationId)
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
          // Why: kill actions only send back the PTY id, so rebuild ownership while listing to keep reconnect-discovered remote sessions routed to their provider.
          ptyOwnership.set(session.id, connectionId)
          deduped.set(session.id, session)
        }
      }
      return Array.from(deduped.values())
    }
  )

  ipcMain.on(
    'pty:getAuthoritativeBufferSnapshotCapabilitiesSync',
    (event, args: { ids?: unknown }) => {
      const ids = Array.isArray(args?.ids) ? args.ids.slice(0, 512) : []
      const capabilities: { id: string; authoritative: boolean | null }[] = []
      const seen = new Set<string>()
      for (const value of ids) {
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > 512 ||
          seen.has(value)
        ) {
          continue
        }
        seen.add(value)
        const provider = tryGetProviderForPty(value)
        // Why: degraded routing mixes preserved daemons with an in-process fallback; keep all panes mounted rather than guess ownership.
        capabilities.push({
          id: value,
          authoritative: provider?.canProvideAuthoritativeBufferSnapshot
            ? provider.canProvideAuthoritativeBufferSnapshot(value)
            : provider && routesFreshSpawnsToLocalProvider(provider)
              ? false
              : null
        })
      }
      // Why: cold deferral runs during render before hidden panes mount; this in-memory route lookup lets legacy PTYs mount in that pass.
      event.returnValue = capabilities
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
      // Why: the cached foreground API would turn stale process identity into shell/agent authority at a command boundary.
      return provider.confirmForegroundProcess?.(args.id) ?? null
    }
  )

  // Why: Cmd+D split needs the live shell cwd so the new pane inherits it (not the worktree root); '' means unknown/unresolvable (Windows) → renderer falls through.
  ipcMain.handle('pty:getCwd', async (_event, args: { id: string }): Promise<string> => {
    try {
      return await getProviderForPty(args.id).getCwd(args.id)
    } catch {
      return ''
    }
  })

  // Why: prefer the provider's APPLIED size over the requested ptySizes so the renderer's resume drift-check can spot a dropped resize; null means "cannot confirm" → re-forward once.
  ipcMain.handle(
    'pty:getSize',
    async (_event, args: { id: string }): Promise<{ cols: number; rows: number } | null> => {
      const provider = tryGetProviderForPty(args.id)
      try {
        if (provider?.getAppliedSize) {
          // Why: a provider-owned null means it could not verify the applied
          // grid; preserve null so the renderer re-forwards instead of trusting
          // the requested-size cache that may describe a dropped resize.
          return await provider.getAppliedSize(args.id)
        }
      } catch {
        // Fall through to the requested-size cache so a dead daemon/relay can't throw across the IPC boundary.
      }
      return ptySizes.get(args.id) ?? null
    }
  )

  // Pre-signal handshake handlers (declare→spawn→settle/clear); see docs/mobile-prefer-renderer-scrollback.md and `pendingByPaneKey` above.
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
      const ptyId = pendingPtyIdBySerializerGeneration.get(args.gen)
      const settledCurrentGeneration = settlePendingPaneSerializer(args.paneKey, args.gen)
      // Why: the generation-to-PTY binding survives late teardown of a reused id; paneKey reverse maps may already be gone.
      pendingPtyIdBySerializerGeneration.delete(args.gen)
      if (settledCurrentGeneration && ptyId) {
        rendererSerializerReadiness.markReady(ptyId)
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
      pendingPtyIdBySerializerGeneration.delete(args.gen)
    }
  )

  ipcMain.handle(
    'pty:reportRendererSerializerReady',
    async (_event, args: { ptyId?: unknown }): Promise<void> => {
      if (
        typeof args.ptyId !== 'string' ||
        !args.ptyId.startsWith('remote:') ||
        args.ptyId.length > 512
      ) {
        return
      }
      // Why: remote-runtime panes skip the local spawn cooperation gate, so their exact PTY id is the only readiness key.
      rendererSerializerReadiness.markReady(args.ptyId)
    }
  )
}

export function registerHeadlessPtyRuntime(
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store,
  prepareCodexSessionResume?: PrepareCodexSessionResume
): void {
  // Why: headless `orca serve` has no renderer window but still needs the same PTY handlers so remote clients can drive terminals.
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
    store,
    { prepareCodexSessionResume }
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
