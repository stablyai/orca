/* eslint-disable max-lines -- Why: shell-ready startup command integration adds
~70 lines of scanner/promise wiring to spawn(). Splitting the method would scatter
tightly coupled PTY lifecycle logic (scan → ready → write → exit cleanup) across
files without a cleaner ownership seam. */
import { basename, delimiter } from 'node:path'
import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
import {
  resolveEffectiveWindowsPowerShell,
  shouldProbeWindowsPowerShellAvailability,
  type WindowsPowerShellShellFamily
} from './windows-powershell'
import { buildWindowsPowerShellSpawnAttempts } from './windows-shell-fallback-chain'
import { resolveProcessCwd } from './process-cwd'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { parseWslPath, isWslAvailable } from '../wsl'
import { splitWorktreeId } from '../../shared/worktree-id'
import {
  injectHistoryEnv,
  updateHistFileForFallback,
  logHistoryInjection
} from '../terminal-history'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'
import {
  ensureNodePtySpawnHelperExecutable,
  validateWorkingDirectory,
  spawnShellWithFallback
} from './local-pty-utils'
import {
  getAttributionShellLaunchConfig,
  getShellReadyLaunchConfig,
  createShellReadyScanState,
  drainShellReadyHeldBytes,
  scanForShellReady,
  writeStartupCommandWhenShellReady,
  STARTUP_COMMAND_READY_MAX_WAIT_MS
} from './local-pty-shell-ready'
import type { ShellReadySignal } from './local-pty-shell-ready'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { addWslEnvKeys } from '../wsl-env'
import {
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  seedPowerlevel10kWizardEnv
} from '../pty/powerlevel10k-wizard-env'
import {
  isWindowsGitBashShellPath,
  resolveGitBashPath,
  resolveWindowsGitBashShellPath
} from '../git-bash'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import { resolveAgentForegroundProcess } from './agent-foreground-process'
import { getAgentForegroundContextPaths } from './agent-foreground-context-paths'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'

const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const

let ptyCounter = 0
const ptyProcesses = new Map<string, pty.IPty>()
const ptyShellName = new Map<string, string>()
const ptyAgentForegroundContextPaths = new Map<string, string[]>()
// Why: node-pty's onData/onExit register native NAPI ThreadSafeFunction
// callbacks. If the PTY is killed without disposing these listeners, the
// stale callbacks survive into node::FreeEnvironment() where NAPI attempts
// to invoke/clean them up on a destroyed environment, triggering a SIGABRT.
const ptyDisposables = new Map<string, { dispose: () => void }[]>()
const ptyCleanupCallbacks = new Map<string, () => void>()

let loadGeneration = 0
const ptyLoadGeneration = new Map<string, number>()

type DataCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void

const dataListeners = new Set<DataCallback>()
const exitListeners = new Set<ExitCallback>()

/**
 * Returns a stable default cwd for locally spawned PTYs.
 */
function getDefaultCwd(): string {
  if (process.platform !== 'win32') {
    return process.env.HOME || '/'
  }

  // Why: USERPROFILE is not guaranteed in all Windows launch contexts.
  // Falling back to bare HOMEPATH yields a drive-relative path, so combine
  // HOMEDRIVE + HOMEPATH to keep spawned PTYs anchored to the intended home.
  if (process.env.USERPROFILE) {
    return process.env.USERPROFILE
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
  }
  return 'C:\\'
}

/**
 * Removes inherited pane identity unless this PTY explicitly supplies it.
 */
function removeUnspecifiedPaneIdentityEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of PANE_IDENTITY_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
}

/**
 * Promotes the agent-teams shim path ahead of inherited PATH entries.
 */
function promoteAgentTeamsShimPath(
  env: Record<string, string>,
  requestedPath: string | undefined
): void {
  if (!env.ORCA_AGENT_TEAMS_TEAM_ID || !requestedPath) {
    return
  }
  const shimDir = requestedPath.split(delimiter)[0]
  if (!shimDir) {
    return
  }
  const currentParts = env.PATH?.split(delimiter).filter(Boolean) ?? []
  env.PATH = [shimDir, ...currentParts.filter((part) => part !== shimDir)].join(delimiter)
}

/**
 * Disposes native node-pty listeners registered for a PTY id.
 */
function disposePtyListeners(id: string): void {
  const disposables = ptyDisposables.get(id)
  if (disposables) {
    for (const d of disposables) {
      d.dispose()
    }
    ptyDisposables.delete(id)
  }
}

function runPtyCleanup(id: string): void {
  const cleanup = ptyCleanupCallbacks.get(id)
  if (!cleanup) {
    return
  }
  ptyCleanupCallbacks.delete(id)
  cleanup()
}

/**
 * Resolves a WSL context from a worktree id whose path is already a WSL path.
 */
function getWslContextFromWorktreeId(
  worktreeId: string | undefined
): { distro: string; treatPosixCwdAsWsl: true } | undefined {
  const worktreePath = worktreeId ? splitWorktreeId(worktreeId)?.worktreePath : undefined
  const wslInfo = worktreePath ? parseWslPath(worktreePath) : null
  return wslInfo ? { distro: wslInfo.distro, treatPosixCwdAsWsl: true } : undefined
}

/**
 * Resolves a WSL launch context from a user-selected distro name.
 */
function getWslContextFromPreferredDistro(
  distro: string | null | undefined
): { distro: string } | undefined {
  const trimmed = distro?.trim()
  return trimmed ? { distro: trimmed } : undefined
}

/**
 * Removes all local tracking state for a PTY id after teardown.
 */
function clearPtyState(id: string): void {
  runPtyCleanup(id)
  disposePtyListeners(id)
  ptyProcesses.delete(id)
  ptyShellName.delete(id)
  ptyAgentForegroundContextPaths.delete(id)
  ptyLoadGeneration.delete(id)
}

/**
 * Allocates either a stable caller-provided PTY id or a new numeric id.
 */
function allocatePtyId(sessionId: string | undefined): string {
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

/**
 * Normalizes renderer session ids that should be reused for local PTY reattach.
 */
function normalizeLocalCallerSessionId(sessionId: string | undefined): string | null {
  const requested = sessionId?.trim()
  if (!requested || /^\d+$/.test(requested)) {
    return null
  }
  return requested
}

/**
 * Normalizes node-pty foreground process strings to executable basenames.
 */
function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

/**
 * Falls back to the spawned Windows shell when node-pty reports a terminal name.
 */
function resolveForegroundFallbackProcess(
  processName: string | null | undefined,
  shellName: string | undefined
): string | null {
  if (process.platform !== 'win32' || normalizeForegroundProcessName(processName)) {
    return processName || null
  }
  // Why: Windows node-pty can expose only the terminal name (`xterm-256color`).
  // The spawned shell is the best fallback for agent foreground enrichment.
  return shellName ?? processName ?? null
}

/** Basename of the spawned shell path, parsed for the *target* platform rather
 *  than the host's native separator. Why: on Windows the shell path uses `\`,
 *  but the POSIX `basename` (used when orchestrating from a non-Windows host or
 *  CI) would not split it and would store the whole `C:\...\powershell.exe`
 *  path as the shell name — breaking the foreground/child-process comparison. */
function getSpawnedShellName(shellPath: string): string {
  return process.platform === 'win32' ? pathWin32.basename(shellPath) : basename(shellPath)
}

/**
 * Disposes the native PTY handle while avoiding recycled-pid signals on POSIX.
 */
function destroyPtyProcess(proc: pty.IPty, options: { alreadyKilled?: boolean } = {}): void {
  // Why: node-pty's UnixTerminal.destroy() closes the master socket, which
  // releases the ptmx fd to the OS — without this call the fd leaks until GC
  // (see docs/fix-pty-fd-leak.md). destroy() also registers a close listener
  // that fires `this.kill('SIGHUP')` AFTER the socket closes. On POSIX, by
  // the time that listener runs the child may have exited and its pid been
  // recycled to an unrelated user process — SIGHUP would land on a Chrome tab,
  // editor, etc. Neutralize proc.kill on this instance before calling
  // destroy() to defuse the hazard. On Windows, destroy() is itself kill();
  // skip it only after we have already killed the ConPTY.
  if (process.platform === 'win32' && options.alreadyKilled) {
    return
  }
  if (process.platform !== 'win32') {
    ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
  }
  try {
    ;(proc as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow — already torn down */
  }
}

/**
 * Kills a local PTY and clears all associated local provider state.
 */
function safeKillAndClean(id: string, proc: pty.IPty): void {
  runPtyCleanup(id)
  disposePtyListeners(id)
  try {
    proc.kill()
  } catch {
    /* Process may already be dead */
  }
  destroyPtyProcess(proc, { alreadyKilled: true })
  clearPtyState(id)
}

export type LocalPtyProviderOptions = {
  /** Why: `ctx.command` carries the renderer-chosen launch command (e.g. `pi`,
   *  `omp`, `claude`). Pi vs OMP must drive overlay source-dir selection in
   *  `buildPtyHostEnv` — a cross-agent disk-presence fallback silently
   *  shadows the other agent's user extensions when both are installed. */
  buildSpawnEnv?: (
    id: string,
    baseEnv: Record<string, string>,
    ctx?: { command?: string; shellPath?: string; isWsl?: boolean; wslDistro?: string | null }
  ) => Record<string, string>
  /** Whether worktree-scoped shell history is enabled. When true (or absent)
   *  and a worktreeId is provided, HISTFILE is scoped per-worktree. */
  isHistoryEnabled?: () => boolean
  /** Why: COMSPEC is always cmd.exe on a stock Windows machine, so reading it
   *  directly would ignore the user's shell preference. This callback lets the
   *  IPC layer inject the persisted setting without coupling the provider to the
   *  settings store. Returns undefined when no preference is set. */
  getWindowsShell?: () => string | undefined
  getWindowsPowerShellImplementation?: () => 'auto' | 'powershell.exe' | 'pwsh.exe' | undefined
  pwshAvailable?: () => boolean
  onSpawned?: (id: string) => void
  onExit?: (id: string, code: number) => void
  onData?: (id: string, data: string, timestamp: number) => void
}

export class LocalPtyProvider implements IPtyProvider {
  private opts: LocalPtyProviderOptions

  constructor(opts: LocalPtyProviderOptions = {}) {
    this.opts = opts
  }

  /** Reconfigure the provider with new hooks (e.g. after window re-creation). */
  configure(opts: LocalPtyProviderOptions): void {
    this.opts = opts
  }

  /**
   * Spawns or reattaches a local PTY session for the renderer process.
   *
   * Windows shell launches can pre-deliver short startup commands in argv; this
   * method preserves that state so the stdin fallback only runs when needed.
   */
  async spawn(args: PtySpawnOptions): Promise<PtySpawnResult> {
    const reattachId = normalizeLocalCallerSessionId(args.sessionId)
    if (reattachId) {
      const existing = ptyProcesses.get(reattachId)
      if (existing) {
        try {
          existing.resize(args.cols, args.rows)
        } catch {
          /* Existing PTY may reject resize during teardown; still return the live handle. */
        }
        return { id: reattachId, pid: existing.pid, isReattach: true }
      }
    }
    const id = allocatePtyId(reattachId ?? undefined)

    const defaultCwd = getDefaultCwd()
    const cwd = args.cwd || defaultCwd
    const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null
    const worktreeWslContext =
      process.platform === 'win32' ? getWslContextFromWorktreeId(args.worktreeId) : undefined
    const preferredWslContext =
      process.platform === 'win32'
        ? getWslContextFromPreferredDistro(args.terminalWindowsWslDistro)
        : undefined

    let shellPath: string
    let shellArgs: string[]
    let effectiveCwd: string
    let validationCwd: string
    let startupCommandDeliveredInShellArgs = false
    let windowsFallbackAttempts: ReturnType<typeof buildWindowsPowerShellSpawnAttempts> = []
    let shellReadyLaunch: ReturnType<typeof getShellReadyLaunchConfig> | null = null
    let getFallbackShellReadyConfig:
      | ((shell: string) => ReturnType<typeof getShellReadyLaunchConfig>)
      | undefined
    if (wslInfo) {
      shellPath = 'wsl.exe'
      const resolved = resolveWindowsShellLaunchArgs(shellPath, cwd, defaultCwd)
      shellArgs = resolved.shellArgs
      effectiveCwd = resolved.effectiveCwd
      validationCwd = resolved.validationCwd
    } else if (process.platform === 'win32') {
      // Why: shellOverride lets a single tab open in a different shell than the
      // persisted default (e.g. "New WSL terminal" from the "+" submenu) without
      // changing the user's setting. It takes priority over the setting.
      const requestedShellFamily =
        args.shellOverride ||
        this.opts.getWindowsShell?.() ||
        process.env.COMSPEC ||
        'powershell.exe'
      const shellFamily = worktreeWslContext ? 'wsl.exe' : requestedShellFamily
      const normalizedShellFamily = pathWin32.basename(shellFamily).toLowerCase()
      const resolvedGitBashPath = resolveWindowsGitBashShellPath(shellFamily)
      // Why: shell selection can arrive either as a canonical setting value
      // ('powershell.exe') or as a concrete PowerShell executable path from a
      // one-off override. Normalize both forms back to the PowerShell family so
      // the shared resolver can still fall back to inbox powershell.exe when
      // pwsh.exe was requested but is unavailable.
      const powerShellImplementation = this.opts.getWindowsPowerShellImplementation?.()
      const resolvedShellFamily: WindowsPowerShellShellFamily =
        normalizedShellFamily === 'powershell.exe' || normalizedShellFamily === 'pwsh.exe'
          ? normalizedShellFamily
          : normalizedShellFamily === 'cmd.exe' || normalizedShellFamily === 'wsl.exe'
            ? normalizedShellFamily
            : undefined
      const shouldProbePwsh = shouldProbeWindowsPowerShellAvailability({
        shellFamily: resolvedShellFamily,
        implementation: powerShellImplementation
      })
      const shouldResolvePowerShellFamily =
        powerShellImplementation !== undefined || pathWin32.basename(shellFamily) === shellFamily
      if (resolvedGitBashPath) {
        shellPath = resolvedGitBashPath
      } else if (shellFamily === WINDOWS_GIT_BASH_SHELL) {
        shellPath = 'powershell.exe'
      } else {
        shellPath = shouldResolvePowerShellFamily
          ? (resolveEffectiveWindowsPowerShell({
              shellFamily: resolvedShellFamily,
              implementation: powerShellImplementation,
              pwshAvailable: shouldProbePwsh ? (this.opts.pwshAvailable?.() ?? false) : false
            }) ?? shellFamily)
          : shellFamily
      }
      // Why: when the selected shell is a PowerShell family, resolve it to a
      // real absolute executable and build a PowerShell -> cmd.exe fallback
      // chain. Handing ConPTY a bare `pwsh.exe` lets Windows resolve it to the
      // Store App Execution Alias stub, whose spawn fails with error code 5.
      // The shared launch-args helper inside keeps both this path and the
      // daemon path producing identical args (chcp 65001 / $PROFILE / wsl cwd).
      windowsFallbackAttempts = buildWindowsPowerShellSpawnAttempts({
        shellPath,
        cwd,
        defaultCwd,
        wslContext: worktreeWslContext ?? preferredWslContext,
        startupCommand: args.command
      })
      const primaryAttempt = windowsFallbackAttempts[0]
      if (primaryAttempt) {
        shellPath = primaryAttempt.shellPath
        shellArgs = primaryAttempt.shellArgs
        effectiveCwd = primaryAttempt.effectiveCwd
        validationCwd = primaryAttempt.validationCwd
        startupCommandDeliveredInShellArgs = primaryAttempt.startupCommandDeliveredInShellArgs
      } else {
        const resolved = resolveWindowsShellLaunchArgs(
          shellPath,
          cwd,
          defaultCwd,
          worktreeWslContext ?? preferredWslContext,
          args.command
        )
        shellArgs = resolved.shellArgs
        effectiveCwd = resolved.effectiveCwd
        validationCwd = resolved.validationCwd
        startupCommandDeliveredInShellArgs = resolved.startupCommandDeliveredInShellArgs === true
      }
    } else {
      shellPath = args.env?.SHELL || process.env.SHELL || '/bin/zsh'
      shellArgs = ['-l']
      effectiveCwd = cwd
      validationCwd = cwd
    }

    ensureNodePtySpawnHelperExecutable()
    validateWorkingDirectory(validationCwd)

    const spawnEnv: Record<string, string> = {
      ...process.env,
      ...args.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Orca',
      // Why: TUIs feature-gate on TERM_PROGRAM_VERSION (Neovim's termcap
      // autodetection, bat/delta paging hints). Sourced from ORCA_APP_VERSION
      // which main/index.ts seeds from app.getVersion() at startup; the
      // fallback keeps tests and non-Electron runs working.
      TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
      // Why: opt tools (Claude Code, ls --hyperlink, etc.) into emitting OSC 8
      // hyperlinks. The `supports-hyperlinks` npm package gates on a hard-coded
      // TERM_PROGRAM allowlist (iTerm.app / WezTerm / vscode) and returns false
      // for TERM_PROGRAM=Orca, so callers drop OSC 8 output entirely and emit
      // bare text instead. xterm.js in Orca parses OSC 8 and the pane's
      // linkHandler routes clicks, so forcing the advertisement is safe and
      // restores clickable refs like `owner/repo#123` / `PR#123`.
      FORCE_HYPERLINK: '1'
    } as Record<string, string>
    // Why: Orca can be launched from an Orca terminal while developing. Pane
    // identity belongs to the child PTY, not the parent shell that spawned app.
    removeUnspecifiedPaneIdentityEnv(spawnEnv, args.env)
    removeAppImageRuntimeEnv(spawnEnv)
    removeInheritedNoColor(spawnEnv)
    for (const key of args.envToDelete ?? []) {
      delete spawnEnv[key]
    }
    if (args.env?.TERM) {
      spawnEnv.TERM = args.env.TERM
    }

    spawnEnv.LANG ??= 'en_US.UTF-8'

    // Why: On Windows, LANG alone does not control the console code page.
    // Programs like Python and Node.js check their own encoding env vars
    // independently. PYTHONUTF8=1 makes Python use UTF-8 for stdio regardless
    // of the Windows console code page, preventing garbled CJK output from
    // Python scripts run inside the terminal.
    if (process.platform === 'win32') {
      spawnEnv.PYTHONUTF8 ??= '1'
      if (isWindowsGitBashShellPath(shellPath)) {
        // Why: Git for Windows login startup files otherwise cd to $HOME,
        // ignoring node-pty's cwd for repo-scoped terminals.
        spawnEnv.CHERE_INVOKING ??= '1'
      }
    }

    const isWslShell = Boolean(wslInfo) || pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe'
    const launchWslDistro =
      wslInfo?.distro ?? worktreeWslContext?.distro ?? preferredWslContext?.distro ?? null
    const finalEnv = this.opts.buildSpawnEnv
      ? this.opts.buildSpawnEnv(id, spawnEnv, {
          command: args.command,
          shellPath,
          isWsl: isWslShell,
          wslDistro: launchWslDistro
        })
      : spawnEnv
    // Why: app-level env hooks can reintroduce vars that special launch modes
    // explicitly scrubbed. Apply deletions last so shims like Claude Agent
    // Teams keep their PATH and terminal-detection contract.
    for (const key of args.envToDelete ?? []) {
      delete finalEnv[key]
    }
    if (args.env?.TERM) {
      finalEnv.TERM = args.env.TERM
    }
    if (process.platform === 'win32') {
      const codexHomeWslInfo = finalEnv.CODEX_HOME ? parseWslPath(finalEnv.CODEX_HOME) : null
      if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
        if (codexHomeWslInfo) {
          if (launchWslDistro && launchWslDistro !== codexHomeWslInfo.distro) {
            delete finalEnv.CODEX_HOME
            delete finalEnv.ORCA_CODEX_HOME
          } else {
            finalEnv.CODEX_HOME = codexHomeWslInfo.linuxPath
            finalEnv.ORCA_CODEX_HOME = codexHomeWslInfo.linuxPath
            // Why: wsl.exe only imports non-default env vars named in WSLENV.
            addWslEnvKeys(finalEnv, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
            if (!launchWslDistro) {
              const resolved = resolveWindowsShellLaunchArgs(shellPath, cwd, defaultCwd, {
                distro: codexHomeWslInfo.distro
              })
              shellArgs = resolved.shellArgs
              effectiveCwd = resolved.effectiveCwd
              validationCwd = resolved.validationCwd
              startupCommandDeliveredInShellArgs =
                resolved.startupCommandDeliveredInShellArgs === true
            }
          }
        } else if (isHostCodexHomeForWsl(finalEnv.CODEX_HOME)) {
          // Why: Orca's selected Codex runtime home is host-local. WSL Codex
          // must use its Linux-side ~/.codex instead of a Windows path.
          delete finalEnv.CODEX_HOME
          delete finalEnv.ORCA_CODEX_HOME
        } else if (finalEnv.CODEX_HOME) {
          addWslEnvKeys(finalEnv, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
        }
        if (finalEnv.CLAUDE_CONFIG_DIR) {
          // Why: managed WSL Claude accounts pass a Linux CLAUDE_CONFIG_DIR
          // through Windows wsl.exe; non-default env vars need WSLENV import.
          addWslEnvKeys(finalEnv, ['CLAUDE_CONFIG_DIR'])
        }
      } else if (codexHomeWslInfo || isWslCodexHomeForHost(finalEnv.CODEX_HOME)) {
        // Why: WSL-managed Codex homes are Linux paths. Windows Codex cannot use
        // them. ORCA_CODEX_HOME must go too because shell-ready scripts restore
        // CODEX_HOME from it after user profiles run.
        delete finalEnv.CODEX_HOME
        delete finalEnv.ORCA_CODEX_HOME
      }
    }
    seedPowerlevel10kWizardEnv(finalEnv, { envToDelete: args.envToDelete })
    if (
      finalEnv[POWERLEVEL10K_WIZARD_DISABLE_ENV] !== undefined &&
      process.platform === 'win32' &&
      pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe'
    ) {
      addWslEnvKeys(finalEnv, [POWERLEVEL10K_WIZARD_DISABLE_ENV])
    }
    if (!wslInfo && process.platform !== 'win32') {
      // Why: OpenCode/Codex path restoration and OMP's typed-command status
      // wrapper need shell-ready code after user startup files run.
      const needsNoMarkerWrapper =
        finalEnv.ORCA_ATTRIBUTION_SHIM_DIR ||
        finalEnv.ORCA_OPENCODE_CONFIG_DIR ||
        finalEnv.ORCA_MIMOCODE_HOME ||
        finalEnv.ORCA_OMP_STATUS_EXTENSION ||
        finalEnv.ORCA_CODEX_HOME ||
        finalEnv.ORCA_AGENT_TEAMS_SHIM_DIR
      const isCodexStartupCommand =
        recognizeAgentProcessFromCommandLine(args.command)?.agent === 'codex'
      let shellLaunch: ReturnType<typeof getShellReadyLaunchConfig> | null = null
      if (args.command && isCodexStartupCommand) {
        const shouldWaitForShellReady = shouldUseShellReadyStartupDelivery({
          command: args.command,
          startupCommandDelivery: args.startupCommandDelivery
        })
        // Why: payload-bearing Codex startup text can be dropped by rc-file noise;
        // plain Codex stays markerless to preserve the startup-speed path.
        getFallbackShellReadyConfig = (shell) =>
          shouldWaitForShellReady
            ? getShellReadyLaunchConfig(shell)
            : getAttributionShellLaunchConfig(shell)
        shellLaunch = shouldWaitForShellReady
          ? getShellReadyLaunchConfig(shellPath)
          : getAttributionShellLaunchConfig(shellPath)
      } else if (args.command) {
        getFallbackShellReadyConfig = (shell) => getShellReadyLaunchConfig(shell)
        shellLaunch = getShellReadyLaunchConfig(shellPath)
      } else if (needsNoMarkerWrapper) {
        getFallbackShellReadyConfig = (shell) => getAttributionShellLaunchConfig(shell)
        shellLaunch = getAttributionShellLaunchConfig(shellPath)
      } else {
        getFallbackShellReadyConfig = undefined
      }
      if (shellLaunch) {
        Object.assign(finalEnv, shellLaunch.env)
        shellArgs = shellLaunch.args ?? shellArgs
        shellReadyLaunch = args.command ? shellLaunch : null
      }
    }
    promoteAgentTeamsShimPath(finalEnv, args.env?.PATH)

    // ── Worktree-scoped shell history (§7–§10 of terminal-history-scope-design) ──
    // Why: without this, all worktree terminals share a single global HISTFILE
    // so ArrowUp in worktree B surfaces commands from worktree A.
    const worktreeId = args.worktreeId
    const historyEnabled = worktreeId && (this.opts.isHistoryEnabled?.() ?? true)
    // Resolve the effective shell kind for history injection. For WSL, the
    // outer executable is wsl.exe but the inner login shell is bash.
    const isWslTerminal =
      Boolean(wslInfo || worktreeWslContext || preferredWslContext) ||
      pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe'
    const effectiveShellPath = isWslTerminal ? 'bash' : shellPath
    let historyResult: ReturnType<typeof injectHistoryEnv> | null = null
    if (historyEnabled) {
      historyResult = injectHistoryEnv(finalEnv, worktreeId, effectiveShellPath, cwd, {
        wslDistro: preferredWslContext?.distro ?? worktreeWslContext?.distro ?? null
      })
      logHistoryInjection(worktreeId, historyResult)
    }

    const spawnResult = spawnShellWithFallback({
      shellPath,
      shellArgs,
      cols: args.cols,
      rows: args.rows,
      cwd: effectiveCwd,
      env: finalEnv,
      termName: finalEnv.TERM,
      ptySpawn: pty.spawn,
      getShellReadyConfig: getFallbackShellReadyConfig,
      // Why: if zsh failed and bash took over, HISTFILE still points to
      // zsh_history. Update it *before* spawn so the child inherits the
      // correct filename (see design doc §8).
      onBeforeFallbackSpawn: historyResult?.histFile
        ? (env, fallbackShell) => updateHistFileForFallback(env, fallbackShell)
        : undefined,
      windowsFallbackAttempts
    })
    shellPath = spawnResult.shellPath
    // Why: a Windows fallback (e.g. cmd.exe) embeds its own startup command in
    // argv, so honor the winning shell's delivery flag to avoid a double write.
    if (spawnResult.startupCommandDeliveredInShellArgs !== undefined) {
      startupCommandDeliveredInShellArgs = spawnResult.startupCommandDeliveredInShellArgs
    }
    if (args.command && getFallbackShellReadyConfig) {
      shellReadyLaunch = getFallbackShellReadyConfig(shellPath)
    }

    if (process.platform !== 'win32') {
      finalEnv.SHELL = shellPath
    }

    const proc = spawnResult.process
    ptyProcesses.set(id, proc)
    ptyShellName.set(id, getSpawnedShellName(shellPath))
    ptyAgentForegroundContextPaths.set(
      id,
      getAgentForegroundContextPaths({ cwd: args.cwd, worktreeId: args.worktreeId })
    )
    ptyLoadGeneration.set(id, loadGeneration)
    this.opts.onSpawned?.(id)

    // Shell-ready startup command support
    let resolveShellReady: ((signal: ShellReadySignal) => void) | null = null
    let shellReadyTimeout: ReturnType<typeof setTimeout> | null = null
    const shellReadyScanState = shellReadyLaunch?.supportsReadyMarker
      ? createShellReadyScanState()
      : null
    const shellReadyPromise = args.command
      ? new Promise<ShellReadySignal>((resolve) => {
          resolveShellReady = resolve
        })
      : Promise.resolve({ postMarkerBytesObserved: false })
    const finishShellReady = (signal: ShellReadySignal): void => {
      if (!resolveShellReady) {
        return
      }
      if (shellReadyTimeout) {
        clearTimeout(shellReadyTimeout)
        shellReadyTimeout = null
      }
      const resolve = resolveShellReady
      resolveShellReady = null
      resolve(signal)
    }
    const releaseHeldShellReadyBytes = (): void => {
      if (!shellReadyScanState) {
        return
      }
      const heldBytes = drainShellReadyHeldBytes(shellReadyScanState)
      if (heldBytes.length === 0) {
        return
      }
      this.opts.onData?.(id, heldBytes, Date.now())
      for (const cb of dataListeners) {
        cb({ id, data: heldBytes })
      }
    }
    if (args.command) {
      if (shellReadyLaunch?.supportsReadyMarker) {
        shellReadyTimeout = setTimeout(() => {
          releaseHeldShellReadyBytes()
          finishShellReady({ postMarkerBytesObserved: false })
        }, STARTUP_COMMAND_READY_MAX_WAIT_MS)
      } else {
        finishShellReady({ postMarkerBytesObserved: false })
      }
    }
    let startupCommandCleanup: (() => void) | null = null
    if (args.command) {
      ptyCleanupCallbacks.set(id, () => {
        if (shellReadyTimeout) {
          clearTimeout(shellReadyTimeout)
          shellReadyTimeout = null
        }
        releaseHeldShellReadyBytes()
        startupCommandCleanup?.()
        startupCommandCleanup = null
        resolveShellReady = null
      })
    }

    const disposables: { dispose: () => void }[] = []
    const onDataDisposable = proc.onData((rawData) => {
      let data = rawData
      if (shellReadyScanState && resolveShellReady) {
        const scanned = scanForShellReady(shellReadyScanState, rawData)
        data = scanned.output
        if (scanned.matched) {
          finishShellReady({ postMarkerBytesObserved: scanned.postMarkerBytesObserved })
        }
      }
      if (data.length === 0) {
        return
      }
      this.opts.onData?.(id, data, Date.now())
      for (const cb of dataListeners) {
        cb({ id, data })
      }
    })
    if (onDataDisposable) {
      disposables.push(onDataDisposable)
    }

    const onExitDisposable = proc.onExit(({ exitCode }) => {
      // Why: neutralize proc.kill the instant the child is reaped, before any
      // other work in this callback. node-pty's UnixTerminal installs a
      // `_socket.once('close', () => this.kill('SIGHUP'))` handler at destroy
      // time, but the master socket can also emit 'close' on natural exit
      // between this onExit callback starting and destroyPtyProcess() running
      // below. If 'close' wins, SIGHUP is dispatched to proc.pid — which on
      // POSIX has already been reaped and may have been recycled to an
      // unrelated process. Synchronous neutralization here closes that window.
      // Windows is exempt: WindowsTerminal.destroy is implemented via kill().
      if (process.platform !== 'win32') {
        ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
      }
      if (shellReadyTimeout) {
        clearTimeout(shellReadyTimeout)
        shellReadyTimeout = null
      }
      startupCommandCleanup?.()
      clearPtyState(id)
      // Why: release the master ptmx fd on the natural-exit path — without
      // this, a shell that exits cleanly (the common case) never releases its
      // fd until the next GC. See docs/fix-pty-fd-leak.md.
      destroyPtyProcess(proc)
      this.opts.onExit?.(id, exitCode)
      for (const cb of exitListeners) {
        cb({ id, code: exitCode })
      }
    })
    if (onExitDisposable) {
      disposables.push(onExitDisposable)
    }
    ptyDisposables.set(id, disposables)

    if (args.command && !startupCommandDeliveredInShellArgs) {
      writeStartupCommandWhenShellReady(shellReadyPromise, proc, args.command, (cleanup) => {
        startupCommandCleanup = cleanup
      })
    }

    // Why: publish the OS pid so ipc/pty can register the PTY with the memory
    // collector without reaching back into the provider. `proc.pid` may be
    // briefly 0/undefined if node-pty hasn't observed the forked child yet.
    const rawPid = proc.pid
    const pid = typeof rawPid === 'number' && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null
    return { id, pid }
  }

  // Local PTYs are always attached -- no-op. Remote providers use this to resubscribe.
  async attach(_id: string): Promise<void> {}
  hasPty(id: string): boolean {
    return ptyProcesses.has(id)
  }
  write(id: string, data: string): void {
    ptyProcesses.get(id)?.write(data)
  }
  resize(id: string, cols: number, rows: number): void {
    ptyProcesses.get(id)?.resize(cols, rows)
  }

  // Why: node-pty caches the last winsize it applied on the IPty handle, so its
  // cols/rows are the authoritative applied size (node-pty clamps invalid dims
  // and a resize on a dead handle is a no-op, neither of which the requested
  // size in ptySizes would reflect). The renderer's resume drift-check compares
  // against this to re-assert a resize the PTY never actually took.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    const proc = ptyProcesses.get(id)
    if (!proc || proc.cols <= 0 || proc.rows <= 0) {
      return null
    }
    return { cols: proc.cols, rows: proc.rows }
  }

  async shutdown(id: string, _opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return
    }
    // Why: disposePtyListeners removes the onExit callback, so the natural
    // exit cleanup path from node-pty won't fire. Cleanup and notification
    // must happen unconditionally after the try/catch.
    // Timer/writer cleanup must happen here too: disposing listeners prevents
    // the natural onExit callback from running the usual clearPtyState path.
    runPtyCleanup(id)
    disposePtyListeners(id)
    try {
      proc.kill()
    } catch {
      /* Process may already be dead */
    }
    destroyPtyProcess(proc, { alreadyKilled: true })
    clearPtyState(id)
    this.opts.onExit?.(id, -1)
    for (const cb of exitListeners) {
      cb({ id, code: -1 })
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return
    }
    try {
      process.kill(proc.pid, signal)
    } catch {
      /* Process may already be dead */
    }
  }

  async getCwd(id: string): Promise<string> {
    const proc = ptyProcesses.get(id)
    // Why: return '' (not throw) on unknown id — the renderer treats empty
    // as "no result, try the next fallback layer". Throwing would surface a
    // noisy rejection for a non-exceptional case (PTY just exited, pane
    // still has its old id).
    if (!proc) {
      return ''
    }
    // Why: resolveProcessCwd returns '' when it can't resolve — let that
    // empty surface so the renderer's fallback chain decides what to do.
    // Handing back a fabricated initialCwd here would lie to the renderer
    // and short-circuit that chain.
    return resolveProcessCwd(proc.pid)
  }
  async getInitialCwd(_id: string): Promise<string> {
    return ''
  }
  async clearBuffer(_id: string): Promise<void> {
    /* handled client-side in xterm.js */
  }
  acknowledgeDataEvent(_id: string, _charCount: number): void {
    /* no flow control for local */
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return false
    }
    try {
      const foreground = proc.process
      const shell = ptyShellName.get(id)
      if (!shell) {
        return true
      }
      return foreground !== shell
    } catch {
      return false
    }
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return null
    }
    try {
      return await resolveAgentForegroundProcess(
        proc.pid,
        resolveForegroundFallbackProcess(proc.process || null, ptyShellName.get(id)),
        {
          contextPaths: ptyAgentForegroundContextPaths.get(id)
        }
      )
    } catch {
      return null
    }
  }

  async serialize(_ids: string[]): Promise<string> {
    return '{}'
  }
  async revive(_state: string): Promise<void> {
    /* re-spawning handles local revival */
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    return Array.from(ptyProcesses.entries()).map(([id, proc]) => ({
      id,
      cwd: '',
      title: proc.process || ptyShellName.get(id) || 'shell'
    }))
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return this.opts.getWindowsShell?.() || process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      const profiles: { name: string; path: string }[] = [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
      const gitBashPath = resolveGitBashPath()
      if (gitBashPath) {
        profiles.push({ name: 'Git Bash', path: gitBashPath })
      }
      if (isWslAvailable()) {
        profiles.push({ name: 'WSL', path: 'wsl.exe' })
      }
      return profiles
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }

  onData(callback: DataCallback): () => void {
    dataListeners.add(callback)
    return () => dataListeners.delete(callback)
  }

  // Local PTYs don't replay -- this is for remote reconnection
  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: ExitCallback): () => void {
    exitListeners.add(callback)
    return () => exitListeners.delete(callback)
  }

  // ─── Local-only helpers (not part of IPtyProvider interface) ───────

  /** Kill orphaned PTYs from previous page loads. */
  killOrphanedPtys(currentGeneration: number): { id: string }[] {
    const killed: { id: string }[] = []
    for (const [id, proc] of ptyProcesses) {
      if ((ptyLoadGeneration.get(id) ?? -1) < currentGeneration) {
        safeKillAndClean(id, proc)
        killed.push({ id })
      }
    }
    return killed
  }

  /** Advance the load generation counter (called on renderer reload). */
  advanceGeneration(): number {
    return ++loadGeneration
  }

  /** Get a writable reference to a PTY (for runtime controller). */
  getPtyProcess(id: string): pty.IPty | undefined {
    return ptyProcesses.get(id)
  }

  /** Kill all PTYs. Call on app quit. */
  killAll(): void {
    for (const [id, proc] of ptyProcesses) {
      safeKillAndClean(id, proc)
    }
  }
}
