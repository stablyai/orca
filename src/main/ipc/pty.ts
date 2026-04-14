/* eslint-disable max-lines -- Why: PTY IPC is intentionally centralized in one
main-process module so spawn-time environment scoping, lifecycle cleanup,
foreground-process inspection, and renderer IPC stay behind a single audited
boundary. Splitting it by line count would scatter tightly coupled terminal
process behavior across files without a cleaner ownership seam. */
import { type BrowserWindow, ipcMain } from 'electron'
export { getBashShellReadyRcfileContent } from '../providers/local-pty-shell-ready'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { GlobalSettings } from '../../shared/types'
import { openCodeHookService } from '../opencode/hook-service'
import { piTitlebarExtensionService } from '../pi/titlebar-extension-service'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import type { IPtyProvider } from '../providers/types'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId. null = local provider.
// SSH providers will be registered here in Phase 1.

const localProvider = new LocalPtyProvider()
const sshProviders = new Map<string, IPtyProvider>()
// Why: PTY IDs are assigned at spawn time with a connectionId, but subsequent
// write/resize/kill calls only carry the PTY ID. This map lets us route
// post-spawn operations to the correct provider without the renderer needing
// to track connectionId per-PTY.
const ptyOwnership = new Map<string, string | null>()

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
  return localProvider
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
  getSettings?: () => GlobalSettings
): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:resize')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeAllListeners('pty:write')

  // Configure the local provider with app-specific hooks
  localProvider.configure({
    isHistoryEnabled: () => getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
    buildSpawnEnv: (id, baseEnv) => {
      const selectedCodexHomePath = getSelectedCodexHomePath?.() ?? null

      const openCodeHookEnv = openCodeHookService.buildPtyEnv(id)
      if (baseEnv.OPENCODE_CONFIG_DIR) {
        // Why: OPENCODE_CONFIG_DIR is a singular extra config root. Replacing a
        // user-provided directory would silently hide their custom OpenCode
        // config, so preserve it and fall back to title-only detection there.
        delete openCodeHookEnv.OPENCODE_CONFIG_DIR
      }
      Object.assign(baseEnv, openCodeHookEnv)
      // Why: PI_CODING_AGENT_DIR owns Pi's full config/session root. Build a
      // PTY-scoped overlay from the caller's chosen root so Pi sessions keep
      // their user state without sharing a mutable overlay across terminals.
      Object.assign(
        baseEnv,
        piTitlebarExtensionService.buildPtyEnv(id, baseEnv.PI_CODING_AGENT_DIR)
      )

      // Why: the selected Codex account should affect Codex launched inside
      // Orca terminals too, not just Orca's background quota fetches. Inject
      // the managed CODEX_HOME only into this PTY environment so the override
      // stays scoped to Orca terminals instead of mutating the app process or
      // the user's external shells.
      if (selectedCodexHomePath) {
        baseEnv.CODEX_HOME = selectedCodexHomePath
      }

      return baseEnv
    },
    onSpawned: (id) => runtime?.onPtySpawned(id),
    onExit: (id, code) => {
      clearProviderPtyState(id)
      ptyOwnership.delete(id)
      runtime?.onPtyExit(id, code)
    },
    onData: (id, data, timestamp) => runtime?.onPtyData(id, data, timestamp)
  })

  // Wire up provider events → renderer IPC
  localDataUnsub?.()
  localExitUnsub?.()
  localDataUnsub = localProvider.onData((payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', payload)
    }
  })
  localExitUnsub = localProvider.onExit((payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', payload)
    }
  })

  // Kill orphaned PTY processes from previous page loads when the renderer reloads.
  // Why: store the handler reference so we can remove it on re-registration,
  // preventing duplicate handlers after macOS app re-activation.
  if (didFinishLoadHandler) {
    mainWindow.webContents.removeListener('did-finish-load', didFinishLoadHandler)
  }
  didFinishLoadHandler = () => {
    const killed = localProvider.killOrphanedPtys(localProvider.advanceGeneration() - 1)
    for (const { id } of killed) {
      clearProviderPtyState(id)
      ptyOwnership.delete(id)
      runtime?.onPtyExit(id, -1)
    }
  }
  mainWindow.webContents.on('did-finish-load', didFinishLoadHandler)

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
      }
    ) => {
      const provider = getProvider(args.connectionId)
      const result = await provider.spawn({
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
        env: args.env,
        command: args.command,
        worktreeId: args.worktreeId
      })
      ptyOwnership.set(result.id, args.connectionId ?? null)
      return result
    }
  )

  ipcMain.on('pty:write', (_event, args: { id: string; data: string }) => {
    getProviderForPty(args.id).write(args.id, args.data)
  })

  ipcMain.handle('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    getProviderForPty(args.id).resize(args.id, args.cols, args.rows)
  })

  ipcMain.handle('pty:kill', async (_event, args: { id: string }) => {
    // Why: try/finally ensures ptyOwnership is cleaned up even if shutdown
    // throws (e.g. SSH connection already gone). Without this, the stale
    // entry routes future lookups to a dead provider.
    try {
      await getProviderForPty(args.id).shutdown(args.id, true)
    } finally {
      ptyOwnership.delete(args.id)
    }
  })

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
  localProvider.killAll()
}
