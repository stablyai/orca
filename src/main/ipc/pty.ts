/* eslint-disable max-lines -- Why: PTY IPC is intentionally centralized in one
main-process module so spawn-time environment scoping, lifecycle cleanup,
foreground-process inspection, and renderer IPC stay behind a single audited
boundary. Splitting it by line count would scatter tightly coupled terminal
process behavior across files without a cleaner ownership seam. */
import { join, delimiter } from 'path'
import { randomUUID } from 'crypto'
import { type BrowserWindow, ipcMain, app } from 'electron'
export { getBashShellReadyRcfileContent } from '../providers/local-pty-shell-ready'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
import { openCodeHookService } from '../opencode/hook-service'
import { agentHookServer } from '../agent-hooks/server'
import { piTitlebarExtensionService } from '../pi/titlebar-extension-service'
import { isPwshAvailable } from '../pwsh'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { SSH_SESSION_EXPIRED_ERROR, isSshPtyNotFoundError } from '../providers/ssh-pty-provider'
import { mintPtySessionId, isSafePtySessionId } from '../daemon/pty-session-id'
import { addNodePtyRecoveryHint } from '../daemon/node-pty-error-hints'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { CLAUDE_AUTH_ENV_VARS, hasClaudeAuthEnvConflict } from '../claude-accounts/environment'
import {
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned
} from '../claude-accounts/live-pty-gate'
import { applyTerminalAttributionEnv } from '../attribution/terminal-attribution'
import { registerPty, unregisterPty } from '../memory/pty-registry'
import { track } from '../telemetry/client'
import { classifyError } from '../telemetry/classify-error'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../shared/telemetry-events'
import { isRemoteAgentHooksEnabled } from '../../shared/agent-hook-relay'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../shared/stable-pane-id'
import {
  clearMigrationUnsupportedPty,
  clearMigrationUnsupportedPtysForPaneKey
} from '../agent-hooks/migration-unsupported-pty-state'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId. null = local provider.
// SSH providers will be registered here in Phase 1.

let localProvider: IPtyProvider = new LocalPtyProvider()
const sshProviders = new Map<string, IPtyProvider>()
// Why: PTY IDs are assigned at spawn time with a connectionId, but subsequent
// write/resize/kill calls only carry the PTY ID. This map lets us route
// post-spawn operations to the correct provider without the renderer needing
// to track connectionId per-PTY.
const ptyOwnership = new Map<string, string | null>()
// Why: mobile clients must mirror desktop PTY geometry even when the renderer
// cannot provide an xterm snapshot yet, such as immediately after tab creation.
const ptySizes = new Map<string, { cols: number; rows: number }>()
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
const pendingByPaneKey = new Map<string, number>()
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

function rememberPaneKeyForPty(ptyId: string, paneKey: unknown): string | null {
  const normalizedPaneKey = typeof paneKey === 'string' ? paneKey.trim() : ''
  if (!isValidPaneKey(normalizedPaneKey)) {
    return null
  }
  ptyPaneKey.set(ptyId, normalizedPaneKey)
  paneKeyPtyId.set(normalizedPaneKey, ptyId)
  return normalizedPaneKey
}

function declarePendingPaneSerializer(paneKey: string): number {
  const gen = ++pendingSerializerGenSeq
  pendingByPaneKey.set(paneKey, gen)
  return gen
}

function settlePendingPaneSerializer(paneKey: string, gen: number): void {
  if (pendingByPaneKey.get(paneKey) === gen) {
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

function tryGetProviderForPty(ptyId: string): IPtyProvider | undefined {
  try {
    return getProviderForPty(ptyId)
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

function finishPtyShutdown(
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined
): void {
  clearProviderPtyState(id)
  if (connectionId) {
    store?.markSshRemotePtyLease(connectionId, id, 'terminated')
  }
  ptyOwnership.delete(id)
  markClaudePtyExited(id)
}

// ─── Host PTY env assembly ──────────────────────────────────────────
// Why: both the LocalPtyProvider.buildSpawnEnv closure and the daemon-active
// fallback in pty:spawn need the same set of host-local env injections
// (OpenCode plugin dir, agent-hook server coordinates, Pi overlay, Codex
// account home, dev-mode CLI overrides, GitHub attribution shims). They used
// to be implemented twice, which silently drifted — daemon-backed PTYs never
// got the OpenCode plugin, Pi overlay, Codex home, or dev CLI PATH prepend,
// so status dots, per-PTY Pi state, Codex account switching, and CLI→dev
// routing were all broken for daemon users (the common case).
//
// Centralizing the injections here makes future additions fail-safe: a new
// variable added to this function lands in BOTH spawn paths or NEITHER.

export type BuildPtyHostEnvOptions = {
  isPackaged: boolean
  userDataPath: string
  selectedCodexHomePath: string | null
  githubAttributionEnabled: boolean
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
  // Why: the Local path passes a baseEnv that already includes process.env
  // (LocalPtyProvider.spawn merges it before calling buildSpawnEnv). The
  // daemon path passes only args.env since process.env propagates to the
  // daemon subprocess via fork inheritance, not the IPC wire. Checking both
  // sources when reading a potentially-user-provided value keeps the guards
  // in lock-step across spawn paths without pushing process.env onto the
  // IPC wire unnecessarily.
  const preexistingOpenCodeConfigDir =
    baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR ??
    process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR ??
    baseEnv.OPENCODE_CONFIG_DIR ??
    process.env.OPENCODE_CONFIG_DIR ??
    readShellStartupEnvVar(
      'OPENCODE_CONFIG_DIR',
      baseEnv.HOME ?? process.env.HOME,
      baseEnv.SHELL ?? process.env.SHELL
    )
  const preexistingPiAgentDir =
    baseEnv.ORCA_PI_SOURCE_AGENT_DIR ??
    process.env.ORCA_PI_SOURCE_AGENT_DIR ??
    baseEnv.PI_CODING_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    readShellStartupEnvVar(
      'PI_CODING_AGENT_DIR',
      baseEnv.HOME ?? process.env.HOME,
      baseEnv.SHELL ?? process.env.SHELL
    )

  // Why: OPENCODE_CONFIG_DIR is a singular path, not a colon-list, so a user
  // value cannot coexist with an Orca-only injection. Hand the user's value
  // (when present) to the hook service and let it materialize a per-PTY
  // mirror overlay that lets the user's plugins and Orca's status plugin
  // load together — same pattern Pi uses below for PI_CODING_AGENT_DIR. See
  // docs/opencode-config-dir-collision.md.
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
    }
  }

  // Why: Claude/Codex native hooks run inside the shell process, so Orca
  // must inject the loopback receiver coordinates before the agent starts.
  // Without these env vars the global hook config cannot map callbacks back
  // to the correct Orca pane.
  Object.assign(baseEnv, agentHookServer.buildPtyEnv())

  // Why: PI_CODING_AGENT_DIR owns Pi's full config/session root. Build a
  // PTY-scoped overlay from the caller's chosen root so Pi sessions keep
  // their user state without sharing a mutable overlay across terminals.
  // Under the daemon path, `id` is the daemon sessionId — the overlay
  // survives daemon cold restore because the sessionId is stable across
  // restarts by design. A future reader should NOT "simplify" id allocation
  // back to a fresh UUID per spawn; that would discard user Pi state on
  // every daemon reconnect.
  Object.assign(baseEnv, piTitlebarExtensionService.buildPtyEnv(id, preexistingPiAgentDir))
  if (baseEnv.PI_CODING_AGENT_DIR) {
    // Why: ~/.zshrc can re-export the user's default after spawn; shell-ready
    // wrappers restore this PTY-scoped value after user startup files run.
    baseEnv.ORCA_PI_CODING_AGENT_DIR = baseEnv.PI_CODING_AGENT_DIR
    if (preexistingPiAgentDir) {
      // Why: preserve the original Pi root across nested Orca terminals; the
      // public env var is intentionally restored to the current PTY overlay.
      baseEnv.ORCA_PI_SOURCE_AGENT_DIR = preexistingPiAgentDir
    }
  }

  // Why: Codex account switching now materializes auth into one shared
  // runtime home (~/.codex), and Codex launched inside Orca terminals must
  // use that same prepared home as quota fetches and other entry points.
  // Keep the override PTY-scoped so Orca does not mutate the app process
  // environment or the user's unrelated external shells.
  if (opts.selectedCodexHomePath) {
    baseEnv.CODEX_HOME = opts.selectedCodexHomePath
  }

  // Why: in dev mode the `orca` CLI defaults to the production userData
  // path, which routes status updates to the packaged Orca instead of this
  // dev instance. Injecting ORCA_USER_DATA_PATH ensures CLI calls from
  // agents running inside dev terminals reach the correct runtime. We also
  // prepend the dev CLI launcher directory to PATH so `orca` resolves to
  // the dev build (which supports ORCA_USER_DATA_PATH) instead of the
  // production binary at /usr/local/bin/orca.
  if (!opts.isPackaged) {
    baseEnv.ORCA_USER_DATA_PATH ??= opts.userDataPath
    const devCliBin = join(opts.userDataPath, 'cli', 'bin')
    // Why: avoid a trailing delimiter when PATH is empty — some shells
    // treat an empty segment as `.`, which would let commands resolve from
    // the current working directory (a foot-gun we don't want to create
    // for dev terminals).
    baseEnv.PATH = baseEnv.PATH ? `${devCliBin}${delimiter}${baseEnv.PATH}` : devCliBin
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
    userDataPath: opts.userDataPath
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
  ptySizes.delete(id)
  const paneKey = ptyPaneKey.get(id)
  const stillOwnsPaneKey = paneKey ? paneKeyPtyId.get(paneKey) === id : false
  // Why: drop the memory-collector registration so a dead PTY does not keep
  // trying to resolve its (now-dead) pid on every snapshot. Safe no-op for
  // PTYs that were never registered (SSH-owned).
  unregisterPty(id)
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
let didFinishLoadHandler: (() => void) | null = null

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

// Why: the "Restart daemon" flow needs to detach listeners from the current
// adapter *after* synthetic pty:exit events fan out (so the renderer receives
// them) but *before* replaceDaemonProvider swaps in the new adapter (so the
// new provider isn't missing bindings). This export narrows that window to
// the caller.
export function unbindLocalProviderListeners(): void {
  localDataUnsub?.()
  localExitUnsub?.()
  localDataUnsub = null
  localExitUnsub = null
}

// ─── IPC Registration ───────────────────────────────────────────────

export function registerPtyHandlers(
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService,
  getSelectedCodexHomePath?: () => string | null,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: () => Promise<ClaudeRuntimeAuthPreparation>,
  store?: Store
): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:listSessions')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeHandler('pty:getCwd')
  ipcMain.removeHandler('pty:declarePendingPaneSerializer')
  ipcMain.removeHandler('pty:settlePaneSerializer')
  ipcMain.removeHandler('pty:clearPendingPaneSerializer')
  ipcMain.removeAllListeners('pty:write')
  ipcMain.removeAllListeners('pty:ackColdRestore')
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
      buildSpawnEnv: (id, baseEnv) => {
        const env = buildPtyHostEnv(id, baseEnv, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath: getSelectedCodexHomePath?.() ?? null,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false
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
  // throughput, with no perceptible latency increase for interactive use.
  const pendingData = new Map<string, string>()
  const trustedTerminalHandleEnv = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const PTY_BATCH_INTERVAL_MS = 8

  const flushPendingData = (): void => {
    flushTimer = null
    if (mainWindow.isDestroyed()) {
      pendingData.clear()
      return
    }
    for (const [id, data] of pendingData) {
      mainWindow.webContents.send('pty:data', { id, data })
    }
    pendingData.clear()
  }

  // Why: extracted so the "Restart daemon" flow can rebind against the fresh
  // adapter after replaceDaemonProvider runs. Both the startup registration
  // and the post-restart rebind go through the same code path — no risk of
  // drift between the two entry points.
  const bindProviderListeners = (): void => {
    localDataUnsub?.()
    localExitUnsub?.()

    // Why: LocalPtyProvider routes data to the runtime via configure().onData,
    // but daemon-backed providers don't have configure(). Without this, daemon
    // PTY data never reaches the runtime's tail buffer, so terminal.read returns
    // empty and agent-detection from raw data never fires. Runtime tails also
    // power mobile read/stream, so they must be notified regardless of window
    // state.
    const isLocalProvider = localProvider instanceof LocalPtyProvider

    localDataUnsub = localProvider.onData((payload) => {
      if (!isLocalProvider) {
        runtime?.onPtyData(payload.id, payload.data, Date.now())
      }
      if (mainWindow.isDestroyed()) {
        // Why: clear the pending flush timer so it doesn't fire after the window
        // is gone. Without this, macOS app re-activation leaks orphaned timers
        // from the previous window's registration.
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        pendingData.clear()
        return
      }
      const existing = pendingData.get(payload.id)
      pendingData.set(payload.id, existing ? existing + payload.data : payload.data)
      if (!flushTimer) {
        flushTimer = setTimeout(flushPendingData, PTY_BATCH_INTERVAL_MS)
      }
    })
    localExitUnsub = localProvider.onExit((payload) => {
      if (!isLocalProvider) {
        clearProviderPtyState(payload.id)
        ptyOwnership.delete(payload.id)
        markClaudePtyExited(payload.id)
        runtime?.onPtyExit(payload.id, payload.code)
      }
      if (!mainWindow.isDestroyed()) {
        // Why: flush any batched data for this PTY before sending the exit event,
        // otherwise the last ≤8ms of output is silently lost because the renderer
        // tears down the terminal on pty:exit before the batch timer fires.
        const remaining = pendingData.get(payload.id)
        if (remaining) {
          mainWindow.webContents.send('pty:data', { id: payload.id, data: remaining })
          pendingData.delete(payload.id)
        }
        mainWindow.webContents.send('pty:exit', payload)
      }
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

  // Kill orphaned PTY processes from previous page loads when the renderer reloads.
  // Why: only applies to LocalPtyProvider where PTYs live in the Electron main
  // process and can become orphaned on page reload. Daemon-backed sessions
  // survive renderer restarts by design — orphan cleanup would kill them.
  if (localProvider instanceof LocalPtyProvider) {
    const lp = localProvider
    if (didFinishLoadHandler) {
      mainWindow.webContents.removeListener('did-finish-load', didFinishLoadHandler)
    }
    didFinishLoadHandler = () => {
      const killed = lp.killOrphanedPtys(lp.advanceGeneration() - 1)
      for (const { id } of killed) {
        clearProviderPtyState(id)
        ptyOwnership.delete(id)
        markClaudePtyExited(id)
        runtime?.onPtyExit(id, -1)
      }
    }
    mainWindow.webContents.on('did-finish-load', didFinishLoadHandler)
  }

  // Why: the runtime controller must route through getProviderForPty() so that
  // CLI commands (terminal.send, terminal.stop) work for both local and remote PTYs.
  // Hardcoding localProvider.getPtyProcess() would silently fail for remote PTYs.
  runtime?.setPtyController({
    spawn: async (args) => {
      const provider = getProvider(args.connectionId)
      const isClaudeLaunch = !args.connectionId && isClaudeLaunchCommand(args.command)
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      const claudeAuth = isClaudeLaunch && prepareClaudeAuth ? await prepareClaudeAuth() : null
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      if (claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
        throw new Error(
          'This Claude launch defines explicit Anthropic auth environment variables. Remove those overrides before using a managed Claude account.'
        )
      }

      const isDaemonHostSpawn = !args.connectionId && !(provider instanceof LocalPtyProvider)
      const sessionId = isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined
      let env: Record<string, string> | undefined = claudeAuth
        ? { ...args.env, ...claudeAuth.envPatch }
        : args.env
      if (args.preAllocatedHandle) {
        env = { ...env, ORCA_TERMINAL_HANDLE: args.preAllocatedHandle }
      }
      if (isDaemonHostSpawn && sessionId) {
        if (!isSafePtySessionId(sessionId, app.getPath('userData'))) {
          throw new Error('Invalid PTY session id')
        }
        env = buildPtyHostEnv(sessionId, env ?? {}, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath: getSelectedCodexHomePath?.() ?? null,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false
        })
      }

      const spawnOptions: PtySpawnOptions = {
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
        env
      }
      if (claudeAuth?.stripAuthEnv) {
        spawnOptions.envToDelete = [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
      }
      if (args.command !== undefined) {
        spawnOptions.command = args.command
      }
      if (args.worktreeId !== undefined) {
        spawnOptions.worktreeId = args.worktreeId
      }
      if (sessionId !== undefined) {
        spawnOptions.sessionId = sessionId
        ptySizes.set(sessionId, { cols: args.cols, rows: args.rows })
      }
      if (process.platform === 'win32' && !args.connectionId) {
        spawnOptions.shellOverride = getSettings?.()?.terminalWindowsShell
        spawnOptions.terminalWindowsPowerShellImplementation = getSettings
          ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
          : undefined
      }

      let result: PtySpawnResult
      try {
        if (args.preAllocatedHandle) {
          trustedTerminalHandleEnv.add(args.preAllocatedHandle)
        }
        result = await provider.spawn(spawnOptions)
      } catch (err) {
        if (sessionId !== undefined) {
          ptySizes.delete(sessionId)
          clearProviderPtyState(sessionId)
        }
        throw normalizeNodePtySpawnError(err)
      } finally {
        if (args.preAllocatedHandle) {
          trustedTerminalHandleEnv.delete(args.preAllocatedHandle)
        }
      }
      ptyOwnership.set(result.id, args.connectionId ?? null)
      ptySizes.set(result.id, { cols: args.cols, rows: args.rows })
      if (args.preAllocatedHandle) {
        runtime?.registerPreAllocatedHandleForPty(result.id, args.preAllocatedHandle)
      }
      if (args.worktreeId) {
        runtime?.registerPty(result.id, args.worktreeId)
      }
      if (isClaudeLaunch) {
        markClaudePtySpawned(result.id)
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
      return { id: result.id }
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
      let connectionId: string | null | undefined
      try {
        connectionId = ptyOwnership.get(ptyId)
        provider = getProviderForPty(ptyId)
      } catch {
        if (connectionId) {
          // Why: runtime/CLI close can target a detached SSH PTY after its
          // provider was unregistered. Tombstone the lease so reconnect does
          // not revive a terminal the user explicitly closed.
          finishPtyShutdown(ptyId, connectionId, store)
          runtime?.onPtyExit(ptyId, -1)
          return true
        }
        return false
      }
      // Why: shutdown() is async but the PtyController interface is sync. Defer
      // cleanup until shutdown resolves so transient SSH/daemon failures don't
      // hide a still-running remote process or local daemon session.
      void provider
        .shutdown(ptyId, { immediate: false })
        .then(() => {
          finishPtyShutdown(ptyId, connectionId, store)
          runtime?.onPtyExit(ptyId, -1)
        })
        .catch((err) => {
          if (isPtyAlreadyGoneError(err)) {
            finishPtyShutdown(ptyId, connectionId, store)
            runtime?.onPtyExit(ptyId, -1)
            return
          }
          console.warn(
            `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return true
    },
    getForegroundProcess: async (ptyId) => {
      try {
        return await getProviderForPty(ptyId).getForegroundProcess(ptyId)
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
        ...Array.from(sshProviders.values(), (provider) => provider.listProcesses().catch(() => []))
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
        ptySizes.set(ptyId, { cols, rows })
        getProviderForPty(ptyId).resize(ptyId, cols, rows)
        return true
      } catch {
        return false
      }
    }
  })

  // ─── IPC Handlers (thin dispatch layer) ─────────────────────────

  ipcMain.handle(
    'pty:spawn',
    async (
      _event,
      args: {
        cols: number
        rows: number
        cwd?: string
        env?: Record<string, string>
        command?: string
        connectionId?: string | null
        worktreeId?: string
        sessionId?: string
        shellOverride?: string
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
      const provider = getProvider(args.connectionId)
      const isClaudeLaunch = !args.connectionId && isClaudeLaunchCommand(args.command)
      if (isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
        throw new Error('A Claude account switch is in progress. Try again after it finishes.')
      }
      const claudeAuth = isClaudeLaunch && prepareClaudeAuth ? await prepareClaudeAuth() : null
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
      // host-local env (OpenCode plugin, agent-hook server, Pi overlay, Codex
      // home, dev CLI overrides, GitHub attribution shims) here so both spawn
      // paths behave identically. buildPtyHostEnv is the shared helper that
      // encapsulates the full set of injections and their order/guards.
      //
      // Safety: skip the entire injection when a remote (SSH) connection is in
      // play. Every injection here is either host-loopback (the agent-hook
      // server binds 127.0.0.1, so shipping its token to an SSH host would
      // leak a loopback secret for no functional benefit) or a path on the
      // local filesystem (OpenCode plugin dir, Pi overlay, Codex home, dev
      // CLI bin, attribution shim dir) that would resolve to nothing — or
      // something misleading — on the remote machine.
      const isDaemonHostSpawn = !args.connectionId && !(provider instanceof LocalPtyProvider)
      // Why: Pi's PTY overlay is keyed on the id we pass down, and the daemon
      // path needs a stable id BEFORE provider.spawn so the overlay can be
      // materialized in buildPtyHostEnv. DaemonPtyAdapter.doSpawn mints an id
      // the same way when sessionId is absent — lifting the mint here gives
      // pty.ts the id up-front without changing daemon semantics (the daemon
      // still honors opts.sessionId ?? mint()).
      //
      // Note: the sessionId is STABLE across daemon restarts by design —
      // DaemonPtyAdapter.reconcileOnStartup reuses it so that users' live
      // shells survive crashes. Keying the Pi overlay on this same id means
      // the user's Pi state (auth, sessions, skills) survives daemon cold
      // restore too. Do NOT "simplify" id allocation back to a fresh UUID
      // per spawn; that would discard Pi state on every reconnect.
      // Why: only state for ids we minted in THIS request should be cleared on
      // spawn failure. If the caller supplied args.sessionId it may refer to
      // an existing PTY whose state (OpenCode hooks, Pi overlay, agent-hook
      // pane caches) we must not clobber on a retry/attach failure.
      const isMintedSessionId = args.sessionId === undefined && isDaemonHostSpawn
      const effectiveSessionId =
        args.sessionId ?? (isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
      // Why: the renderer sets pane env for SSH too. Only forward it to the
      // remote when the relay hook path is enabled; otherwise a newer relay
      // could emit statuses this Orca build is not prepared to route.
      let sshSourceEnv = args.env
      if (args.connectionId && !isRemoteAgentHooksEnabled()) {
        if (
          sshSourceEnv &&
          ('ORCA_PANE_KEY' in sshSourceEnv ||
            'ORCA_TAB_ID' in sshSourceEnv ||
            'ORCA_WORKTREE_ID' in sshSourceEnv)
        ) {
          const stripped = { ...sshSourceEnv }
          delete stripped.ORCA_PANE_KEY
          delete stripped.ORCA_TAB_ID
          delete stripped.ORCA_WORKTREE_ID
          sshSourceEnv = stripped
        }
      }
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
      const baseEnv = baseEnvWithAuth
        ? { ...baseEnvWithAuth, ...(stablePaneKey ? { ORCA_PANE_KEY: stablePaneKey } : {}) }
        : undefined
      if (baseEnv && !stablePaneKey) {
        // Why: ORCA_PANE_KEY crosses into shells and hook registries. Only the
        // key proven to match this spawn's tab+leaf may leave the IPC boundary.
        delete baseEnv.ORCA_PANE_KEY
      }
      const validatedPaneKey = stablePaneKey
      const validatedLeafId = verifiedLeafId ?? metadataLeafId
      let env: Record<string, string> | undefined = baseEnv
      const preAllocatedHandle =
        runtime && !(provider instanceof LocalPtyProvider)
          ? runtime.createPreAllocatedTerminalHandle()
          : null
      if (isDaemonHostSpawn) {
        if (effectiveSessionId === undefined) {
          // Should be unreachable: the expression above returns a string when
          // isDaemonHostSpawn is true. Defense-in-depth in case future edits
          // break this invariant.
          throw new Error('Invariant violation: daemon spawn without sessionId')
        }
        const sessionIdForEnv = effectiveSessionId
        // Why: Pi overlay paths are derived from the session id; reject
        // traversal sequences / path separators so a crafted IPC payload
        // cannot escape the overlay root. If the renderer ever forwards a
        // malicious sessionId or worktreeId the spawn is refused before any
        // filesystem side-effects run.
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
            selectedCodexHomePath: getSelectedCodexHomePath?.() ?? null,
            githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false
          })
        } catch (err) {
          // Why: buildPtyHostEnv has filesystem side-effects (Pi overlay
          // materialization). If it throws before we reach provider.spawn,
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
      const spawnEnv = preAllocatedHandle
        ? { ...env, ORCA_TERMINAL_HANDLE: preAllocatedHandle }
        : env
      const envToDelete = claudeAuth?.stripAuthEnv
        ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
        : undefined
      const spawnOptions: PtySpawnOptions = {
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
        env: spawnEnv
      }
      if (envToDelete) {
        spawnOptions.envToDelete = envToDelete
      }
      if (args.command !== undefined) {
        spawnOptions.command = args.command
      }
      if (args.worktreeId !== undefined) {
        spawnOptions.worktreeId = args.worktreeId
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
      const effectiveShellOverride =
        args.shellOverride ??
        (process.platform === 'win32' && !args.connectionId
          ? getSettings?.()?.terminalWindowsShell
          : undefined)
      if (effectiveShellOverride !== undefined) {
        spawnOptions.shellOverride = effectiveShellOverride
      }
      if (effectiveSessionId !== undefined) {
        // Why: daemon PTYs can emit prompt/startup bytes before spawn()
        // resolves. Runtime headless snapshots need the real pane geometry
        // for those early bytes; otherwise they default to 80x24 and wrap TUIs.
        ptySizes.set(effectiveSessionId, { cols: args.cols, rows: args.rows })
      }
      if (process.platform === 'win32' && !args.connectionId) {
        // Why: the renderer only models PowerShell as one shell family. Thread
        // the persisted implementation choice through spawnOptions so both the
        // in-process and daemon-backed PTY paths can resolve the same effective
        // executable without inventing a fourth top-level shell.
        spawnOptions.terminalWindowsPowerShellImplementation = getSettings
          ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
          : undefined
      }
      let result: PtySpawnResult
      try {
        if (preAllocatedHandle) {
          trustedTerminalHandleEnv.add(preAllocatedHandle)
        }
        result = await provider.spawn(spawnOptions)
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err)
        const spawnError = normalizeNodePtySpawnError(err)
        if (effectiveSessionId !== undefined) {
          ptySizes.delete(effectiveSessionId)
        }
        if (
          args.connectionId &&
          effectiveSessionId !== undefined &&
          (spawnError.message.includes(SSH_SESSION_EXPIRED_ERROR) ||
            rawMessage.includes(SSH_SESSION_EXPIRED_ERROR))
        ) {
          // Why: expired remote reattach means the relay has already dropped
          // the backing PTY. Clear the durable lease so later session writes
          // cannot restore the stale pane binding.
          clearProviderPtyState(effectiveSessionId)
          deletePtyOwnership(effectiveSessionId)
          store?.markSshRemotePtyLease(args.connectionId, effectiveSessionId, 'expired')
        }
        // Why: when buildPtyHostEnv materialized a Pi overlay for this id
        // but provider.spawn failed, the overlay would leak.
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
      ptyOwnership.set(result.id, args.connectionId ?? null)
      if (store && args.connectionId) {
        // Why: remote PTYs live in the SSH relay grace window after Orca
        // detaches. Persist their IDs immediately so reconnect can reattach
        // instead of treating the tab as a fresh shell.
        store.upsertSshRemotePtyLease({
          targetId: args.connectionId,
          ptyId: result.id,
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
            ptyId: result.id
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
            store.removeSshRemotePtyLease(args.connectionId, result.id)
          }
          throw new Error(
            'Failed to save terminal session state. Check disk space and Orca data directory permissions, then try again.'
          )
        }
      }
      // Why: pre-signal cooperation gate — when the renderer has declared it
      // will own the serializer for this paneKey, suppress the daemon-snapshot
      // seed so the renderer's hydration path (maybeHydrateHeadlessFromRenderer)
      // is the sole authority. The pre-signal is keyed on paneKey because at
      // spawn time the renderer doesn't yet know the new ptyId. See
      // docs/mobile-prefer-renderer-scrollback.md.
      const rendererPreSignaled = validatedPaneKey ? pendingByPaneKey.has(validatedPaneKey) : false
      const rendererAlreadyRegistered = rendererSerializerByPtyId.has(result.id)
      // Why: capture the pending gen at spawn time so teardown for THIS PTY
      // only settles its own generation. A remount that replaces the entry
      // with a new gen must not be stomped by the old PTY's teardown.
      if (validatedPaneKey && rendererPreSignaled) {
        const gen = pendingByPaneKey.get(validatedPaneKey)
        if (gen !== undefined) {
          ptyPendingGenByPtyId.set(result.id, gen)
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
          runtime.seedHeadlessTerminal(result.id, result.snapshot, seedSize)
        } else if (
          result.coldRestore &&
          typeof result.coldRestore.scrollback === 'string' &&
          result.coldRestore.scrollback.length > 0
        ) {
          runtime.seedHeadlessTerminal(result.id, result.coldRestore.scrollback, seedSize)
        }
      }
      if (
        typeof args.worktreeId === 'string' &&
        args.worktreeId.length > 0 &&
        args.worktreeId.length <= 512
      ) {
        runtime?.registerPty(result.id, args.worktreeId)
      }
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
      return result
    }
  )

  ipcMain.on('pty:write', (_event, args: { id: string; data: string }) => {
    // Why: defense-in-depth for the mobile-presence lock. The renderer's
    // xterm.onData guard already drops desktop keystrokes when mobile is
    // driving, but a stale view between the main-side state flip and the
    // IPC arriving in the renderer can let one keystroke slip through.
    // This server-side check catches it. See
    // docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return
    }
    tryGetProviderForPty(args.id)?.write(args.id, args.data)
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
    // Why: presence-lock defense-in-depth. While mobile is driving,
    // desktop-side resizes (auto-fit on window resize, split drag) must
    // not reach the PTY. The renderer guard checks the driver state too,
    // but this is the load-bearing layer because the renderer mirror lags
    // by one IPC hop. Note: BOTH guards apply — isResizeSuppressed handles
    // the safeFit cascade after take-back; this driver check handles the
    // ongoing locked state. See docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return
    }
    ptySizes.set(args.id, { cols: args.cols, rows: args.rows })
    tryGetProviderForPty(args.id)?.resize(args.id, args.cols, args.rows)
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

  ipcMain.removeAllListeners('pty:signal')
  ipcMain.on('pty:signal', (_event, args: { id: string; signal: string }) => {
    tryGetProviderForPty(args.id)
      ?.sendSignal(args.id, args.signal)
      .catch(() => {})
  })

  ipcMain.handle('pty:kill', async (_event, args: { id: string; keepHistory?: boolean }) => {
    const connectionId = ptyOwnership.get(args.id)
    const provider = tryGetProviderForPty(args.id)
    if (!provider && connectionId) {
      // Why: detached SSH PTYs intentionally keep ownership after their
      // provider is unregistered. If the user closes the pane while detached,
      // make the lease non-restorable instead of reviving it on reconnect.
      finishPtyShutdown(args.id, connectionId, store)
      return
    }
    try {
      await (provider ?? getProviderForPty(args.id)).shutdown(args.id, {
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
    // Why: onExit clears provider state for LocalPtyProvider, but remote SSH
    // and daemon shutdown paths do not emit onExit through the local provider's
    // listener. Explicit cleanup is idempotent and covers already-dead PTYs.
    finishPtyShutdown(args.id, connectionId, store)
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

  ipcMain.handle(
    'pty:hasChildProcesses',
    async (_event, args: { id: string }): Promise<boolean> => {
      return getProviderForPty(args.id).hasChildProcesses(args.id)
    }
  )

  ipcMain.handle(
    'pty:getForegroundProcess',
    async (_event, args: { id: string }): Promise<string | null> => {
      return getProviderForPty(args.id).getForegroundProcess(args.id)
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

  // Why: pre-signal handshake handlers. See
  // docs/mobile-prefer-renderer-scrollback.md and the rationale on
  // `pendingByPaneKey` above. The IPC contract is: renderer awaits declare
  // (capturing the returned gen), awaits pty:spawn, then registers its
  // serializer locally and calls settle (echoing the gen). On spawn rejection
  // or pane unmount before settle, renderer calls clear with the same gen.
  ipcMain.handle(
    'pty:declarePendingPaneSerializer',
    async (_event, args: { paneKey?: unknown }): Promise<number> => {
      if (!isValidPaneKey(args.paneKey)) {
        throw new Error('Invalid paneKey')
      }
      return declarePendingPaneSerializer(args.paneKey)
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
  getSelectedCodexHomePath?: () => string | null,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: () => Promise<ClaudeRuntimeAuthPreparation>,
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
 * Kill all PTY processes. Call on app quit.
 */
export function killAllPty(): void {
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.killAll()
  }
}
