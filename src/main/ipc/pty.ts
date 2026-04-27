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
import type { GlobalSettings } from '../../shared/types'
import { openCodeHookService } from '../opencode/hook-service'
import { agentHookServer } from '../agent-hooks/server'
import { piTitlebarExtensionService } from '../pi/titlebar-extension-service'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import type { IPtyProvider, PtySpawnOptions } from '../providers/types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { CLAUDE_AUTH_ENV_VARS, hasClaudeAuthEnvConflict } from '../claude-accounts/environment'
import {
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned
} from '../claude-accounts/live-pty-gate'
import { applyTerminalAttributionEnv } from '../attribution/terminal-attribution'
import { registerPty, unregisterPty } from '../memory/pty-registry'

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
    baseEnv.OPENCODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR
  const preexistingPiAgentDir = baseEnv.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR

  const openCodeHookEnv = openCodeHookService.buildPtyEnv(id)
  if (preexistingOpenCodeConfigDir) {
    // Why: OPENCODE_CONFIG_DIR is a singular extra config root. Replacing a
    // user-provided directory would silently hide their custom OpenCode
    // config, so preserve it. The Orca status plugin will not load, so the
    // dashboard falls back to a blank status for that pane until the user
    // unsets their override.
    delete openCodeHookEnv.OPENCODE_CONFIG_DIR
  }
  Object.assign(baseEnv, openCodeHookEnv)

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

/** Get the local PTY provider (for direct access in tests/runtime). */
export function getLocalPtyProvider(): LocalPtyProvider {
  // Why: callers that need LocalPtyProvider-specific methods (killOrphanedPtys,
  // advanceGeneration, getPtyProcess) can only work with the local provider.
  // Daemon mode replaces it with an adapter, so callers must use this only when
  // they know the concrete local provider is installed.
  return localProvider as LocalPtyProvider
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
  // Why: drop the memory-collector registration so a dead PTY does not keep
  // trying to resolve its (now-dead) pid on every snapshot. Safe no-op for
  // PTYs that were never registered (SSH-owned).
  unregisterPty(id)
  // Why: the hook server's per-paneKey caches (lastPrompt / lastTool) would
  // otherwise accumulate entries for dead panes over the process lifetime.
  // Use the spawn-time paneKey mapping since the server has no other way to
  // correlate a ptyId back to its paneKey.
  const paneKey = ptyPaneKey.get(id)
  if (paneKey) {
    agentHookServer.clearPaneState(paneKey)
    ptyPaneKey.delete(id)
    paneKeyPtyId.delete(paneKey)
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

export function deletePtyOwnership(id: string): void {
  ptyOwnership.delete(id)
}

// Why: localProvider.onData/onExit return unsubscribe functions. Without
// storing and calling these on re-registration, macOS app re-activation
// creates a new BrowserWindow and re-calls registerPtyHandlers, leaking
// duplicate listeners that forward every event twice.
let localDataUnsub: (() => void) | null = null
let localExitUnsub: (() => void) | null = null
let didFinishLoadHandler: (() => void) | null = null

// ─── IPC Registration ───────────────────────────────────────────────

export function registerPtyHandlers(
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService,
  getSelectedCodexHomePath?: () => string | null,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: () => Promise<ClaudeRuntimeAuthPreparation>
): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:listSessions')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeAllListeners('pty:write')
  ipcMain.removeAllListeners('pty:ackColdRestore')

  // Configure the local provider with app-specific hooks.
  // Why: only LocalPtyProvider has the configure() method — daemon-backed
  // providers handle subprocess spawning internally and don't need main-process
  // hook injection. The hooks (buildSpawnEnv, onSpawned, etc.) only make sense
  // when the PTY lives in the Electron main process.
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.configure({
      isHistoryEnabled: () => getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
      getWindowsShell: () => getSettings?.()?.terminalWindowsShell,
      buildSpawnEnv: (id, baseEnv) =>
        buildPtyHostEnv(id, baseEnv, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath: getSelectedCodexHomePath?.() ?? null,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false
        }),
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

  // Wire up provider events → renderer IPC
  localDataUnsub?.()
  localExitUnsub?.()

  // Why: batching PTY data into short flush windows (8ms ≈ half a frame)
  // reduces IPC round-trips from hundreds/sec to ~120/sec under high
  // throughput, with no perceptible latency increase for interactive use.
  const pendingData = new Map<string, string>()
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

  localDataUnsub = localProvider.onData((payload) => {
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
      const provider = getProviderForPty(ptyId)
      // Why: shutdown() is async but the PtyController interface is sync.
      // Swallowing the rejection prevents an unhandled promise rejection crash
      // if the remote SSH session is already gone.
      void provider.shutdown(ptyId, false).catch(() => {})
      clearProviderPtyState(ptyId)
      markClaudePtyExited(ptyId)
      runtime?.onPtyExit(ptyId, -1)
      return true
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
      const effectiveSessionId =
        args.sessionId ??
        (isDaemonHostSpawn
          ? args.worktreeId
            ? `${args.worktreeId}@@${randomUUID().slice(0, 8)}`
            : randomUUID()
          : undefined)
      const baseEnv = claudeAuth ? { ...args.env, ...claudeAuth.envPatch } : args.env
      let env: Record<string, string> | undefined = baseEnv
      if (isDaemonHostSpawn) {
        // Why: clone before mutating so we don't leak injections back into
        // args.env (which the renderer may reuse for other IPC calls).
        env = { ...baseEnv }
        buildPtyHostEnv(effectiveSessionId as string, env, {
          isPackaged: app.isPackaged,
          userDataPath: app.getPath('userData'),
          selectedCodexHomePath: getSelectedCodexHomePath?.() ?? null,
          githubAttributionEnabled: getSettings?.()?.enableGitHubAttribution ?? false
        })
      }
      const envToDelete = claudeAuth?.stripAuthEnv
        ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
        : undefined
      const spawnOptions: PtySpawnOptions = {
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
        env
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
      const result = await provider.spawn(spawnOptions)
      ptyOwnership.set(result.id, args.connectionId ?? null)
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
      const paneKey = args.env?.ORCA_PANE_KEY
      if (typeof paneKey === 'string' && paneKey.length > 0 && paneKey.length <= 256) {
        ptyPaneKey.set(result.id, paneKey)
        paneKeyPtyId.set(paneKey, result.id)
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
          paneKey: typeof paneKey === 'string' ? paneKey : null,
          pid:
            typeof spawnedPid === 'number' && Number.isFinite(spawnedPid) && spawnedPid > 0
              ? spawnedPid
              : null
        })
      }
      return result
    }
  )

  ipcMain.on('pty:write', (_event, args: { id: string; data: string }) => {
    getProviderForPty(args.id).write(args.id, args.data)
  })

  // Why: resize is fire-and-forget — the renderer doesn't need a reply.
  // Using ipcMain.on (not .handle) halves IPC traffic by avoiding the
  // empty acknowledgement message back to the renderer.
  ipcMain.removeAllListeners('pty:resize')
  ipcMain.on('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    getProviderForPty(args.id).resize(args.id, args.cols, args.rows)
  })

  // Why: fire-and-forget — clears the DaemonPtyAdapter's sticky cold restore
  // cache after the renderer has consumed the data. No-op for non-daemon providers.
  ipcMain.on('pty:ackColdRestore', (_event, args: { id: string }) => {
    const provider = getProviderForPty(args.id)
    if ('ackColdRestore' in provider && typeof provider.ackColdRestore === 'function') {
      provider.ackColdRestore(args.id)
    }
  })

  ipcMain.removeAllListeners('pty:signal')
  ipcMain.on('pty:signal', (_event, args: { id: string; signal: string }) => {
    getProviderForPty(args.id)
      .sendSignal(args.id, args.signal)
      .catch(() => {})
  })

  ipcMain.handle('pty:kill', async (_event, args: { id: string }) => {
    // Why: try/finally ensures ptyOwnership is cleaned up even if shutdown
    // throws (e.g. SSH connection already gone or daemon session already
    // reaped). Swallowing the error prevents noisy renderer-side rejections
    // when killing orphaned sessions that the daemon has already discarded.
    try {
      await getProviderForPty(args.id).shutdown(args.id, true)
    } catch {
      /* session already dead — cleanup below handles the rest */
    } finally {
      // Why: onExit clears provider state for LocalPtyProvider, but remote
      // SSH and daemon shutdown paths do not emit onExit through the local
      // provider's listener. Call clearProviderPtyState explicitly here so
      // the hook-server paneKey cache and OpenCode/Pi PTY-scoped state are
      // cleared on explicit kill. clearProviderPtyState is idempotent — safe
      // if onExit already ran.
      clearProviderPtyState(args.id)
      ptyOwnership.delete(args.id)
      markClaudePtyExited(args.id)
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
}

/**
 * Kill all PTY processes. Call on app quit.
 */
export function killAllPty(): void {
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.killAll()
  }
}
