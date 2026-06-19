/* eslint-disable max-lines -- Why: daemon PTY spawning centralizes platform launch setup,
   preflight validation, and lifecycle guards that must stay in one execution path. */
import * as pty from 'node-pty'
import { statSync } from 'fs'
import { delimiter, win32 as pathWin32 } from 'path'
import type { SubprocessHandle } from './session'
import { DaemonProtocolError } from './types'
import {
  getAttributionShellLaunchConfig,
  getShellReadyLaunchConfig,
  resolvePtyShellPath
} from './shell-ready'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import {
  ensureNodePtySpawnHelperExecutable,
  getNodePtySpawnHelperCandidates,
  validateWorkingDirectory
} from '../providers/local-pty-utils'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'
import { resolveEffectiveWindowsPowerShell } from '../providers/windows-powershell'
import { isPwshAvailable } from '../pwsh'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { parseWslPath } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'
import { getWslContextFromSessionId } from './wsl-session-context'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { isWindowsGitBashShellPath, resolveWindowsGitBashShellPath } from '../git-bash'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import { resolveAgentForegroundProcess } from '../providers/agent-foreground-process'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import {
  shouldUseShellReadyStartupDelivery,
  type StartupCommandDelivery
} from '../../shared/codex-startup-delivery'
import { isShellProcess } from '../../shared/shell-process-detection'
import { parsePtySessionId } from './pty-session-id'
import { getAgentForegroundContextPaths } from '../providers/agent-foreground-context-paths'

const PANE_IDENTITY_ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_WORKTREE_ID'] as const
const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000
const PTY_SPAWN_HEALTH_TIMEOUT_MS = 2_000

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  /** Explicit shell executable path/basename the renderer asked for.
   *  Overrides env.COMSPEC / env.SHELL resolution inside the daemon so a user
   *  who picks "New WSL terminal" from the "+" menu actually gets WSL. */
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
}

function getDefaultCwd(): string {
  if (process.platform !== 'win32') {
    return process.env.HOME || '/'
  }

  // Why: HOMEPATH alone is drive-relative (`\\Users\\name`). Pair it with
  // HOMEDRIVE when USERPROFILE is unavailable so daemon-spawned Windows PTYs
  // still start in a valid absolute home directory.
  if (process.env.USERPROFILE) {
    return process.env.USERPROFILE
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
  }
  return 'C:\\'
}

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

function removeInheritedDevAgentHookEndpoint(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  if (explicitEnv?.ORCA_AGENT_HOOK_ENV === 'development' && !explicitEnv.ORCA_AGENT_HOOK_ENDPOINT) {
    // Why: the daemon inherits the app process env before per-PTY env is
    // merged. Strip only stale parent endpoints; a fresh explicit endpoint is
    // needed by hooks whose runners scrub token-like env vars before exec.
    delete env.ORCA_AGENT_HOOK_ENDPOINT
  }
}

function getWslContextFromPreferredDistro(
  distro: string | null | undefined
): { distro: string } | undefined {
  const trimmed = distro?.trim()
  return trimmed ? { distro: trimmed } : undefined
}

function removeInheritedElectronRunAsNode(env: Record<string, string>): void {
  // Why: the daemon needs ELECTRON_RUN_AS_NODE=1 internally, but user shells
  // must not inherit it or nested Electron commands run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
}

function formatMissingDaemonPathError(kind: 'helper' | 'cwd', path: string): DaemonProtocolError {
  const detailName = kind === 'helper' ? 'helper' : 'cwd'
  const step = kind === 'helper' ? 'posix_spawn' : 'daemon_cwd'
  return new DaemonProtocolError(
    `Daemon's ${kind === 'helper' ? 'node-pty install' : 'working directory'} is gone ` +
      `(worktree deleted?). Restart Orca. node-pty: ${step} failed: ENOENT ` +
      `(errno 2, No such file or directory) - ${detailName}='${path}'`
  )
}

function isExistingDirectory(path: string | undefined): path is string {
  if (!path) {
    return false
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function repairDaemonCwd(): string | null {
  const candidates = [
    process.env.ORCA_USER_DATA_PATH,
    getDefaultCwd(),
    process.platform === 'win32' ? 'C:\\' : '/'
  ]
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      try {
        process.chdir(candidate)
        return candidate
      } catch {
        // Try the next stable cwd candidate.
      }
    }
  }
  return null
}

function preflightDaemonCwd(): void {
  let daemonCwd = '<unavailable>'
  try {
    daemonCwd = process.cwd()
    if (isExistingDirectory(daemonCwd)) {
      return
    }
  } catch {
    // Recover below; process.cwd() throws after the original cwd is deleted.
  }

  // Why: older detached daemons were launched from the repo cwd. If that
  // worktree disappears, node-pty's macOS spawn-helper can fail even when the
  // requested terminal cwd is valid.
  if (repairDaemonCwd()) {
    return
  }
  throw formatMissingDaemonPathError('cwd', daemonCwd)
}

function preflightMacNodePtySpawnEnvironment(): void {
  if (process.platform !== 'darwin') {
    return
  }

  preflightDaemonCwd()

  let candidates: string[]
  try {
    candidates = getNodePtySpawnHelperCandidates()
  } catch {
    throw formatMissingDaemonPathError('helper', '<unresolved>')
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return
      }
    } catch {
      // Try the next node-pty native location.
    }
  }

  throw formatMissingDaemonPathError('helper', candidates[0] ?? '<unresolved>')
}

function isNativeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function preflightWindowsPtySpawnEnvironment(args: {
  validationCwd: string
  cwdWasExplicit: boolean
}): void {
  if (process.platform !== 'win32' || !args.cwdWasExplicit) {
    return
  }

  if (!isNativeWindowsPath(args.validationCwd)) {
    return
  }

  validateWorkingDirectory(args.validationCwd)
}

function formatPtySpawnError(err: unknown, shellPath: string, spawnCwd: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  const formatted = new DaemonProtocolError(
    `Daemon failed to spawn shell "${shellPath}" with cwd "${spawnCwd}": ${message}`
  )
  if (err instanceof Error && err.stack) {
    formatted.stack = err.stack
  }
  return formatted
}

export async function checkPtySpawnHealth(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  ensureNodePtySpawnHelperExecutable()
  preflightMacNodePtySpawnEnvironment()

  const cwd = isExistingDirectory(process.env.ORCA_USER_DATA_PATH)
    ? process.env.ORCA_USER_DATA_PATH
    : getDefaultCwd()

  let proc: pty.IPty
  try {
    proc = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 2,
      rows: 1,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      }
    })
  } catch (err) {
    throw formatPtySpawnError(err, '/bin/sh', cwd)
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let exitDisposable: { dispose(): void } | undefined
    const finish = (error?: Error, opts?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      exitDisposable?.dispose()
      if (opts?.kill) {
        try {
          proc.kill()
        } catch {
          // Best-effort cleanup for a short-lived health probe.
        }
      }
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timer = setTimeout(() => {
      finish(new Error(`PTY spawn health check timed out after ${PTY_SPAWN_HEALTH_TIMEOUT_MS}ms`), {
        kill: true
      })
    }, PTY_SPAWN_HEALTH_TIMEOUT_MS)

    // Why: ping only proves the daemon protocol is alive. A real short-lived
    // PTY spawn catches stale node-pty helper paths captured by this process.
    exitDisposable = proc.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        finish()
        return
      }
      finish(new Error(`PTY spawn health check exited with code ${exitCode}`))
    })
  })
}

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  const normalized = normalizeForegroundProcessName(processName)
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  // Why: Windows node-pty can report the terminal name instead of the shell.
  // Use the spawned shell so shell-rooted foreground enrichment still runs.
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}

export function createPtySubprocess(opts: PtySubprocessOptions): SubprocessHandle {
  const size = normalizePtySize(opts.cols, opts.rows)
  const env: Record<string, string> = {
    ...process.env,
    ...opts.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    // Why: TUIs feature-gate on TERM_PROGRAM_VERSION. The daemon is forked
    // by main (daemon-init.ts:93) with the parent's env, so ORCA_APP_VERSION
    // — set in src/main/index.ts from app.getVersion() — is inherited here.
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
  for (const key of opts.envToDelete ?? []) {
    delete env[key]
  }
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
  // Why: the daemon is forked from Electron and can inherit the pane identity
  // of the terminal that launched `pn dev`; each PTY must opt into its own.
  removeUnspecifiedPaneIdentityEnv(env, opts.env)
  removeInheritedDevAgentHookEndpoint(env, opts.env)
  removeInheritedElectronRunAsNode(env)
  removeInheritedNoColor(env)

  env.LANG ??= 'en_US.UTF-8'

  // Why: the shellOverride from the "+" menu (or persisted default shell
  // setting, relayed by main) takes priority over env.COMSPEC — otherwise
  // Windows always resolves to cmd.exe (COMSPEC) or PowerShell by fallback,
  // no matter which shell the user actually picked.
  const cwdWslInfo = process.platform === 'win32' ? parseWslPath(opts.cwd ?? '') : null
  const sessionWslContext =
    process.platform === 'win32' ? getWslContextFromSessionId(opts.sessionId) : undefined
  const preferredWslContext =
    process.platform === 'win32'
      ? getWslContextFromPreferredDistro(opts.terminalWindowsWslDistro)
      : undefined
  // Why: WSL worktree cwd is the repo's execution environment. Older persisted
  // tabs can carry a PowerShell/cmd shellOverride; ignore it so reconnects and
  // daemon-backed terminals enter the WSL distro just like LocalPtyProvider.
  let shellPath =
    cwdWslInfo || sessionWslContext ? 'wsl.exe' : opts.shellOverride || resolvePtyShellPath(env)
  let shellArgs: string[]
  const startupAgentRecognition = recognizeAgentProcessFromCommandLine(opts.command)
  const isCodexStartupCommand = startupAgentRecognition?.agent === 'codex'
  const requestedCwd = opts.cwd || getDefaultCwd()
  let spawnCwd = requestedCwd
  let validationCwd = spawnCwd

  if (process.platform === 'win32') {
    const normalizedShellFamily = pathWin32.basename(shellPath).toLowerCase()
    const resolvedGitBashPath = resolveWindowsGitBashShellPath(shellPath)
    // Why: daemon spawn requests can carry either a canonical shell family
    // (`powershell.exe`) or a concrete PowerShell executable path from a
    // one-off override. Normalize both forms back to the PowerShell family so
    // the shared resolver can still fall back to inbox powershell.exe when
    // pwsh.exe was requested but is unavailable.
    const shouldResolvePowerShellFamily =
      opts.terminalWindowsPowerShellImplementation !== undefined ||
      pathWin32.basename(shellPath) === shellPath
    if (resolvedGitBashPath) {
      shellPath = resolvedGitBashPath
    } else if (shellPath === WINDOWS_GIT_BASH_SHELL) {
      shellPath = 'powershell.exe'
    } else {
      shellPath = shouldResolvePowerShellFamily
        ? (resolveEffectiveWindowsPowerShell({
            shellFamily:
              normalizedShellFamily === 'powershell.exe' || normalizedShellFamily === 'pwsh.exe'
                ? 'powershell.exe'
                : normalizedShellFamily === 'cmd.exe' || normalizedShellFamily === 'wsl.exe'
                  ? normalizedShellFamily
                  : undefined,
            implementation: opts.terminalWindowsPowerShellImplementation,
            pwshAvailable: isPwshAvailable()
          }) ?? shellPath)
        : shellPath
    }
    // Why: matches LocalPtyProvider — CMD needs chcp 65001, PowerShell needs
    // $PROFILE dot-sourcing, WSL needs a --bash entry with a translated cwd.
    // Reuse the same shared launch-args helper after resolving the effective
    // PowerShell executable so daemon-backed terminals preserve parity with the
    // in-process PTY path.
    const resolved = resolveWindowsShellLaunchArgs(
      shellPath,
      spawnCwd,
      getDefaultCwd(),
      sessionWslContext ?? preferredWslContext
    )
    shellArgs = resolved.shellArgs
    spawnCwd = resolved.effectiveCwd
    validationCwd = resolved.validationCwd
    if (isWindowsGitBashShellPath(shellPath)) {
      // Why: Git for Windows login startup files otherwise cd to $HOME,
      // ignoring node-pty's cwd for repo-scoped terminals.
      env.CHERE_INVOKING ??= '1'
    }
    const codexHomeWslInfo = env.CODEX_HOME ? parseWslPath(env.CODEX_HOME) : null
    if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
      if (codexHomeWslInfo) {
        const launchWslDistro =
          cwdWslInfo?.distro ?? sessionWslContext?.distro ?? preferredWslContext?.distro
        if (launchWslDistro && launchWslDistro !== codexHomeWslInfo.distro) {
          delete env.CODEX_HOME
          delete env.ORCA_CODEX_HOME
        } else {
          env.CODEX_HOME = codexHomeWslInfo.linuxPath
          env.ORCA_CODEX_HOME = codexHomeWslInfo.linuxPath
          // Why: wsl.exe only imports non-default env vars named in WSLENV.
          addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
          if (!launchWslDistro) {
            const resolved = resolveWindowsShellLaunchArgs(
              shellPath,
              requestedCwd,
              getDefaultCwd(),
              {
                distro: codexHomeWslInfo.distro
              }
            )
            shellArgs = resolved.shellArgs
            spawnCwd = resolved.effectiveCwd
            validationCwd = resolved.validationCwd
          }
        }
      } else if (isHostCodexHomeForWsl(env.CODEX_HOME)) {
        // Why: Orca's selected Codex runtime home is host-local. WSL Codex
        // must use its Linux-side ~/.codex instead of a Windows path.
        delete env.CODEX_HOME
        delete env.ORCA_CODEX_HOME
      } else if (env.CODEX_HOME) {
        addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
      }
      if (env.CLAUDE_CONFIG_DIR) {
        // Why: managed WSL Claude accounts pass a Linux CLAUDE_CONFIG_DIR
        // through Windows wsl.exe; non-default env vars need WSLENV import.
        addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
      }
    } else if (codexHomeWslInfo || isWslCodexHomeForHost(env.CODEX_HOME)) {
      // Why: WSL-managed Codex homes are Linux paths. Windows Codex cannot use
      // them. ORCA_CODEX_HOME must go too because shell-ready scripts restore
      // CODEX_HOME from it after user profiles run.
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    }
    if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
      addOrcaWslInteropEnv(env)
    }
  } else {
    // Why: relay-side launch modes can ask for host defaults to stay scrubbed
    // even after environment normalization above.
    for (const key of opts.envToDelete ?? []) {
      delete env[key]
    }
    if (opts.env?.TERM) {
      env.TERM = opts.env.TERM
    }
    // Why: OpenCode/Codex path restoration and OMP's typed-command status
    // wrapper need shell-ready code after user startup files run.
    let shellLaunch: ReturnType<typeof getShellReadyLaunchConfig> | null = null
    if (opts.command && isCodexStartupCommand) {
      const shouldWaitForShellReady = shouldUseShellReadyStartupDelivery({
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery
      })
      // Why: payload-bearing Codex startup text can be dropped by rc-file noise;
      // plain Codex stays markerless to preserve the startup-speed path.
      shellLaunch = shouldWaitForShellReady
        ? getShellReadyLaunchConfig(shellPath)
        : getAttributionShellLaunchConfig(shellPath)
    } else if (opts.command) {
      shellLaunch = getShellReadyLaunchConfig(shellPath)
    } else {
      shellLaunch =
        env.ORCA_ATTRIBUTION_SHIM_DIR ||
        env.ORCA_OPENCODE_CONFIG_DIR ||
        env.ORCA_OMP_STATUS_EXTENSION ||
        env.ORCA_CODEX_HOME ||
        env.ORCA_AGENT_TEAMS_SHIM_DIR
          ? getAttributionShellLaunchConfig(shellPath)
          : null
    }
    if (shellLaunch) {
      Object.assign(env, shellLaunch.env)
    }
    shellArgs = shellLaunch?.args ?? ['-l']
  }
  promoteAgentTeamsShimPath(env, opts.env?.PATH)

  // Why: asar packaging can strip the +x bit from node-pty's spawn-helper
  // binary. The main process fixes this via LocalPtyProvider, but the daemon
  // runs in a separate forked process with its own code path.
  ensureNodePtySpawnHelperExecutable()
  preflightMacNodePtySpawnEnvironment()
  preflightWindowsPtySpawnEnvironment({
    validationCwd,
    cwdWasExplicit: opts.cwd !== undefined
  })

  let proc: pty.IPty
  try {
    proc = pty.spawn(shellPath, shellArgs, {
      name: env.TERM ?? 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: spawnCwd,
      env
    })
  } catch (err) {
    if (process.platform === 'win32') {
      throw formatPtySpawnError(err, shellPath, spawnCwd)
    }
    throw err
  }

  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null

  proc.onData((data) => onDataCb?.(data))
  proc.onExit(({ exitCode }) => onExitCb?.(exitCode))

  // Why: node-pty's native NAPI layer throws a C++ Napi::Error when
  // write/resize/kill is called on a PTY whose underlying fd is already
  // closed. This happens in the race window between the child process
  // exiting and the JS onExit callback firing. An uncaught Napi::Error
  // propagates to std::terminate, killing the entire daemon process.
  let dead = false
  let disposed = false
  let nodePtyKillIssued = false
  let cachedAgentForeground: { processName: string; refreshedAt: number } | null = null
  const agentForegroundContextPaths = getAgentForegroundContextPaths({
    cwd: opts.cwd,
    worktreeId: parsePtySessionId(opts.sessionId).worktreeId
  })
  let startupAgentForeground: { processName: string; expiresAt: number } | null =
    startupAgentRecognition
      ? {
          processName: startupAgentRecognition.processName,
          expiresAt: Date.now() + STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null
  let foregroundRefreshInFlight = false
  let lastForegroundRefreshStartedAt = 0
  const getFallbackForegroundProcess = (): string | null =>
    resolveFallbackForegroundProcess(proc.process, shellPath)
  const getActiveStartupAgentForeground = (
    now = Date.now()
  ): { processName: string; expiresAt: number } | null => {
    if (!startupAgentForeground) {
      return null
    }
    if (now > startupAgentForeground.expiresAt) {
      startupAgentForeground = null
      return null
    }
    return startupAgentForeground
  }
  const shouldInspectFallbackForegroundProcess = (fallbackProcess: string | null): boolean =>
    fallbackProcess !== null &&
    (isShellProcess(fallbackProcess) || isAgentForegroundWrapperProcess(fallbackProcess))
  const scheduleAgentForegroundRefresh = (fallbackProcess: string | null): void => {
    if (dead || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      recognizeAgentProcess(fallbackProcess) ||
      !shouldInspectFallbackForegroundProcess(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const retryMs =
      fallbackIsShell && !getActiveStartupAgentForeground(now) && !cachedAgentForeground
        ? SHELL_FOREGROUND_REFRESH_RETRY_MS
        : FOREGROUND_AGENT_CACHE_TTL_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    // Why: daemon foreground reads are sync and run on the IPC hot path.
    // Refresh shell/wrapper-derived identities (powershell/node -> codex/etc.)
    // in the background and serve them from a short cache on later reads.
    void resolveAgentForegroundProcess(proc.pid, fallbackProcess, {
      contextPaths: agentForegroundContextPaths
    })
      .then((processName) => {
        if (dead) {
          return
        }
        if (!processName || !recognizeAgentProcess(processName)) {
          const currentFallbackProcess = getFallbackForegroundProcess()
          if (
            fallbackIsShell &&
            !getActiveStartupAgentForeground() &&
            currentFallbackProcess !== null &&
            isShellProcess(currentFallbackProcess)
          ) {
            cachedAgentForeground = null
            startupAgentForeground = null
          }
          return
        }
        cachedAgentForeground = { processName, refreshedAt: Date.now() }
        startupAgentForeground = null
      })
      .catch(() => {
        // Best-effort only: foreground enrichment must never affect PTY health.
      })
      .finally(() => {
        foregroundRefreshInFlight = false
      })
  }
  proc.onExit(() => {
    dead = true
    cachedAgentForeground = null
    startupAgentForeground = null
    // Why: UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`
    // (unixTerminal.js:219-229). After the child exits, the master socket's
    // 'close' event can fire before our dispose() path gets to neutralize
    // proc.kill — the child's pid may have already been recycled, so SIGHUP
    // lands on an unrelated process. Neutralizing here, synchronously inside
    // the onExit callback, closes that window: once the child is reaped,
    // proc.kill is a no-op no matter which teardown ordering wins.
    // Windows is excluded because WindowsTerminal.destroy relies on kill() to
    // close the ConPTY agent — neutralizing would leak the agent + fds.
    if (process.platform !== 'win32') {
      ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
    }
  })

  return {
    pid: proc.pid,
    getForegroundProcess: () => {
      // Why: node-pty's `.process` getter reports the PTY's live foreground
      // process name (the agent running in the shell, or the shell itself) and
      // updates as it changes. Null once the child is gone — `.process` on a
      // reaped pty can read a recycled pid.
      if (dead) {
        return null
      }
      try {
        const fallbackProcess = getFallbackForegroundProcess()
        if (fallbackProcess && recognizeAgentProcess(fallbackProcess)) {
          cachedAgentForeground = { processName: fallbackProcess, refreshedAt: Date.now() }
          startupAgentForeground = null
          return fallbackProcess
        }
        scheduleAgentForegroundRefresh(fallbackProcess)
        const now = Date.now()
        if (
          cachedAgentForeground &&
          now - cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          return cachedAgentForeground.processName
        }
        const activeStartupAgentForeground = getActiveStartupAgentForeground(now)
        if (fallbackProcess && isShellProcess(fallbackProcess) && activeStartupAgentForeground) {
          return activeStartupAgentForeground.processName
        }
        return fallbackProcess
      } catch {
        return null
      }
    },
    write: (data) => {
      if (dead) {
        return
      }
      try {
        proc.write(data)
      } catch {
        dead = true
      }
    },
    resize: (cols, rows) => {
      if (dead) {
        return
      }
      if (!isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        dead = true
      }
    },
    kill: () => {
      if (dead) {
        return
      }
      try {
        nodePtyKillIssued = true
        proc.kill()
      } catch {
        dead = true
      }
    },
    forceKill: () => {
      // Why: once the child has been reaped (dead=true via onExit) or dispose
      // has run, proc.pid refers to a recycled pid. Sending SIGKILL would
      // terminate an unrelated process. The fd release is handled by
      // dispose()/destroy(); forceKill is strictly for signalling a live child.
      if (dead) {
        return
      }
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        try {
          nodePtyKillIssued = true
          proc.kill()
        } catch {
          // Process may already be dead
        }
      }
    },
    signal: (sig) => {
      // Why: same recycled-pid hazard as forceKill. Once dead, silently drop
      // the signal rather than risk sending it to an unrelated process.
      if (dead) {
        return
      }
      try {
        process.kill(proc.pid, sig)
      } catch {
        // Process may already be dead
      }
    },
    onData: (cb) => {
      onDataCb = cb
    },
    onExit: (cb) => {
      onExitCb = cb
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      dead = true
      onDataCb = null
      onExitCb = null
      // Why: UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`
      // (unixTerminal.js:219-229). The socket close fires asynchronously; by then
      // the child may have exited and its pid been recycled to an unrelated
      // process. Without this neutralization, SIGHUP can be delivered to a
      // Chrome tab, editor, or other user process — silent cross-app corruption.
      // `_socket.destroy()` still releases the fd; only the dangerous SIGHUP is
      // removed.
      //
      // Platform guard: WindowsTerminal.destroy implements the ConPTY close by
      // CALLING `this.kill()` via `_deferNoArgs` (windowsTerminal.js:141-146).
      // Neutralizing kill on Windows turns destroy() into a no-op and leaks the
      // ConPTY agent. The SIGHUP hazard is POSIX-only, so the guard is too.
      if (process.platform !== 'win32') {
        ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
      } else if (nodePtyKillIssued) {
        // Why: WindowsTerminal.destroy() calls kill() internally. If this
        // daemon handle already used node-pty's kill(), destroying here can
        // close the same ConPTY handle twice and trip Windows heap corruption.
        return
      }
      try {
        ;(proc as unknown as { destroy?: () => void }).destroy?.()
      } catch {
        /* swallow — already torn down, or native-side error we can't recover from */
      }
    }
  }
}
