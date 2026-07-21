/* eslint-disable max-lines -- Why: daemon PTY spawning must keep platform launch setup, preflight, and lifecycle guards in one execution path. */
import * as pty from 'node-pty'
import { statSync } from 'node:fs'
import { delimiter, win32 as pathWin32 } from 'node:path'
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
  resolveUnixShellPath,
  validateWorkingDirectory
} from '../providers/local-pty-utils'
import { wrapShellSpawnForMacosTccAttribution } from '../providers/macos-tcc-login-shell'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'
import {
  resolveEffectiveWindowsPowerShell,
  shouldProbeWindowsPowerShellAvailability,
  type WindowsPowerShellShellFamily
} from '../providers/windows-powershell'
import {
  buildWindowsPowerShellSpawnAttempts,
  type WindowsShellSpawnAttempt
} from '../providers/windows-shell-fallback-chain'
import { isPwshAvailable } from '../pwsh'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'
import { stripInheritedBuildModeEnv } from '../pty/build-mode-env'
import { parseWslPath } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'
import {
  gitCredentialPromptGuardEnv,
  mergeGitConfigEnvProtocol
} from '../../shared/git-credential-prompt-env'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../shared/terminal-git-credential-guard'
import { resolveWslSessionContext } from './wsl-session-context'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import {
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  seedPowerlevel10kWizardEnv
} from '../pty/powerlevel10k-wizard-env'
import { isWindowsGitBashShellPath, resolveWindowsGitBashShellPath } from '../git-bash'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import { resolveAgentForegroundProcessWithAvailability } from '../providers/agent-foreground-process'
import { readWindowsConptyProcessIds } from '../providers/windows-conpty-process-membership'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import {
  shouldUseShellReadyStartupDelivery,
  type StartupCommandDelivery
} from '../../shared/codex-startup-delivery'
import { isShellProcess } from '../../shared/shell-process-detection'
import { parsePtySessionId } from './pty-session-id'
import { getAgentForegroundContextPaths } from '../providers/agent-foreground-context-paths'
import { assertSafeAgentStartupCwd, resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import { ORCA_HERMES_STARTUP_QUERY_ENV } from '../../shared/hermes-startup-query'
import type { TuiAgent } from '../../shared/types'
import { forceKillPosixPtyProcessGroups } from '../pty/posix-pty-process-groups'

const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const
const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
// Why: a Windows refresh forks a heavy powershell.exe CIM scan (~10-40x POSIX `ps`); idle shells retry slower, output re-arms the fast retry.
const WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS = 15_000
const SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS = 10_000
const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000
const PTY_SPAWN_HEALTH_TIMEOUT_MS = 4_000
// Why: retry once so a transient slow spawn doesn't route every terminal to the local fallback, losing daemon persistence.
const PTY_SPAWN_HEALTH_RETRY_ATTEMPTS = 2
const PENDING_PRE_LISTENER_DATA_MAX_CHARS = 512 * 1024

function shouldInspectOuterWrapperFallback(processName: string | null): boolean {
  const recognized = recognizeAgentProcess(processName)
  return recognized !== null && shouldInspectOuterWrapperForegroundProcess(recognized)
}

function composeGuardedDaemonGitConfigEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined,
  launchAgent: TuiAgent | undefined
): void {
  const policy = explicitEnv?.[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]
  delete env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]
  if (policy !== 'guard' && launchAgent === undefined) {
    return
  }
  // Why: the daemon can outlive Electron, so its process.env is the authoritative inherited config; append only the guard.
  Object.assign(env, gitCredentialPromptGuardEnv(env, process.platform))
}

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  launchAgent?: TuiAgent
  /** Explicit shell executable path/basename the renderer asked for.
   *  Overrides env.COMSPEC / env.SHELL resolution inside the daemon so a user
   *  who picks "New WSL terminal" from the "+" menu actually gets WSL. */
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
}

function deleteRequestedDaemonEnvKeys(
  env: Record<string, string>,
  keys: readonly string[] | undefined
): void {
  // Why: the persistent daemon's inherited env can differ from Electron's.
  // Compare ownership here so real-home routing neither leaks an Orca overlay
  // nor deletes a user-owned CODEX_HOME chosen by the daemon's host context.
  const deleteOrcaOwnedCodexHome =
    keys?.includes('ORCA_CODEX_HOME') === true &&
    env.ORCA_CODEX_HOME !== undefined &&
    env.CODEX_HOME === env.ORCA_CODEX_HOME
  for (const key of keys ?? []) {
    delete env[key]
  }
  if (deleteOrcaOwnedCodexHome) {
    delete env.CODEX_HOME
  }
}

/**
 * Returns a stable default working directory for daemon-spawned PTYs.
 */
function getDefaultCwd(): string {
  return resolveSafePtyDefaultCwd()
}

/**
 * Removes pane identity inherited from the daemon parent unless explicitly set.
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
 * Removes stale development hook endpoints inherited by daemon children.
 */
function removeInheritedDevAgentHookEndpoint(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  if (explicitEnv?.ORCA_AGENT_HOOK_ENV === 'development' && !explicitEnv.ORCA_AGENT_HOOK_ENDPOINT) {
    // Why: strip only stale inherited endpoints; a fresh explicit one is needed by hooks that scrub token-like env vars before exec.
    delete env.ORCA_AGENT_HOOK_ENDPOINT
  }
}

/**
 * Strips Electron's internal run-as-node flag from user shell environments.
 */
function removeInheritedElectronRunAsNode(env: Record<string, string>): void {
  // Why: user shells must not inherit ELECTRON_RUN_AS_NODE or nested Electron commands run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
}

/**
 * Formats a daemon preflight failure with the same ENOENT details node-pty exposes.
 */
function formatMissingDaemonPathError(kind: 'helper' | 'cwd', path: string): DaemonProtocolError {
  const detailName = kind === 'helper' ? 'helper' : 'cwd'
  const step = kind === 'helper' ? 'posix_spawn' : 'daemon_cwd'
  return new DaemonProtocolError(
    `Daemon's ${kind === 'helper' ? 'node-pty install' : 'working directory'} is gone ` +
      `(worktree deleted?). Restart Orca. node-pty: ${step} failed: ENOENT ` +
      `(errno 2, No such file or directory) - ${detailName}='${path}'`
  )
}

/**
 * Checks whether a path currently exists and is a directory.
 */
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

/**
 * Moves the daemon process to a stable cwd after its original cwd disappears.
 */
function repairDaemonCwd(): string | null {
  const candidates = [process.env.ORCA_USER_DATA_PATH]
  try {
    candidates.push(getDefaultCwd())
  } catch {
    // Keep daemon cwd repair best-effort even when no user terminal cwd is safe.
  }
  candidates.push(process.platform === 'win32' ? 'C:\\' : '/')
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

/**
 * Ensures the daemon cwd is valid before native PTY spawning.
 */
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

  // Why: if the daemon's launch worktree disappears, node-pty's macOS spawn-helper fails even when the terminal cwd is valid.
  if (repairDaemonCwd()) {
    return
  }
  throw formatMissingDaemonPathError('cwd', daemonCwd)
}

/**
 * Validates macOS node-pty helper availability before spawning terminals.
 */
function preflightMacNodePtySpawnEnvironment(): void {
  if (process.platform !== 'darwin') {
    return
  }

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

/**
 * Ensures POSIX daemon-owned native PTY spawn prerequisites are still valid.
 */
function preflightUnixPtySpawnEnvironment(): void {
  if (process.platform === 'win32') {
    return
  }

  // Why: detached daemons can outlive their launch cwd; repair before every spawn so Linux/macOS don't wait for health recovery.
  preflightDaemonCwd()
  preflightMacNodePtySpawnEnvironment()
}

/**
 * Detects native Windows paths that should be validated before spawn.
 */
function isNativeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Validates explicit native Windows cwd paths before ConPTY launch.
 */
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

/**
 * Validates POSIX spawn cwd before node-pty can fail with an opaque ENOENT.
 */
function preflightPosixPtySpawnEnvironment(validationCwd: string): void {
  if (process.platform === 'win32') {
    return
  }
  validateWorkingDirectory(validationCwd)
}

/**
 * Wraps native PTY spawn failures with shell and cwd context.
 */
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

/**
 * Runs one short native PTY spawn probe (spawn `/bin/sh -c 'exit 0'`).
 */
function runSinglePtySpawnHealthProbe(): Promise<void> {
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

  return new Promise<void>((resolve, reject) => {
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

    // Why: ping only proves the protocol is alive; a real spawn catches stale node-pty helper paths.
    exitDisposable = proc.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        finish()
        return
      }
      finish(new Error(`PTY spawn health check exited with code ${exitCode}`))
    })
  })
}

/**
 * Runs a short native PTY spawn probe for daemon health checks, retrying once
 * so a transient stall (e.g. a busy machine right after an upgrade) does not
 * mis-classify a healthy daemon as unable to spawn PTYs.
 */
export async function checkPtySpawnHealth(): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  // Why: a real short-lived spawn catches a deleted cwd or stale native PTY path before panes are routed to a daemon that can't spawn.
  if (process.platform === 'darwin') {
    ensureNodePtySpawnHelperExecutable()
  }
  preflightUnixPtySpawnEnvironment()

  let lastError: unknown
  for (let attempt = 1; attempt <= PTY_SPAWN_HEALTH_RETRY_ATTEMPTS; attempt++) {
    try {
      await runSinglePtySpawnHealthProbe()
      return
    } catch (err) {
      lastError = err
      if (attempt < PTY_SPAWN_HEALTH_RETRY_ATTEMPTS) {
        console.warn(
          `[daemon] PTY spawn health probe attempt ${attempt} failed; retrying`,
          err instanceof Error ? err.message : err
        )
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
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
function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  const normalized = normalizeForegroundProcessName(processName)
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  // Why: Windows node-pty can report the terminal name instead of the shell; fall back to the spawned shell.
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}

/**
 * Spawns the daemon PTY, walking the Windows PowerShell -> cmd.exe fallback
 * chain when ConPTY rejects the primary shell with ERROR_ACCESS_DENIED.
 *
 * Why: the daemon has no LocalPtyProvider, so it owns its chain walk; later attempts recompute args so the cmd.exe fallback still gets `chcp 65001`.
 */
function spawnDaemonPtyWithWindowsFallback(args: {
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  env: Record<string, string>
  cols: number
  rows: number
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
}): {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
} {
  const spawnAt = (shellPath: string, shellArgs: string[], cwd: string): pty.IPty => {
    const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    return pty.spawn(wrapped.file, wrapped.args, {
      name: args.env.TERM ?? 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: args.env,
      // Why: legacy system ConPTY can corrupt full-width TUI rows in scrollback; bundled ConPTY has the wrap-marker behavior xterm expects.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {})
    })
  }

  try {
    return {
      process: spawnAt(args.shellPath, args.shellArgs, args.spawnCwd),
      shellPath: args.shellPath,
      spawnCwd: args.spawnCwd
    }
  } catch (primaryErr) {
    if (process.platform !== 'win32') {
      throw primaryErr
    }
    // Skip the first entry: it is the primary that already failed above.
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      try {
        const process = spawnAt(attempt.shellPath, attempt.shellArgs, attempt.effectiveCwd)
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${args.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          process,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs
        }
      } catch {
        // This fallback shell also failed -- try the next link in the chain.
      }
    }
    throw primaryErr
  }
}

/**
 * Spawns the daemon-owned PTY subprocess for a terminal session.
 *
 * The returned handle records whether the startup command was already embedded
 * in Windows shell args so the daemon host does not write it a second time.
 */
export function createPtySubprocess(opts: PtySubprocessOptions): SubprocessHandle {
  const size = normalizePtySize(opts.cols, opts.rows)
  const env: Record<string, string> = {
    ...mergeGitConfigEnvProtocol(stripInheritedBuildModeEnv(process.env), opts.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    // Why: TUIs feature-gate on TERM_PROGRAM_VERSION; ORCA_APP_VERSION is inherited from the forking main process.
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    // Why: `supports-hyperlinks` gates OSC 8 on a TERM_PROGRAM allowlist excluding Orca; force it since xterm.js parses OSC 8 for clickable links.
    FORCE_HYPERLINK: '1'
  } as Record<string, string>
  composeGuardedDaemonGitConfigEnv(env, opts.env, opts.launchAgent)
  deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
  // Why: the daemon can inherit the pane identity of the terminal that launched `pn dev`; each PTY must opt into its own.
  removeUnspecifiedPaneIdentityEnv(env, opts.env)
  removeInheritedDevAgentHookEndpoint(env, opts.env)
  removeInheritedElectronRunAsNode(env)
  removeAppImageRuntimeEnv(env)
  removeInheritedNoColor(env)

  env.LANG ??= 'en_US.UTF-8'

  // Why: shellOverride must win over env.COMSPEC, or Windows always resolves to cmd.exe/PowerShell regardless of the user's pick.
  const resolvedWslContext = resolveWslSessionContext(opts)
  // Why: older persisted tabs can carry a PowerShell/cmd shellOverride; ignore it so WSL reconnects still enter the distro.
  let shellPath = resolvedWslContext ? 'wsl.exe' : opts.shellOverride || resolvePtyShellPath(env)
  let shellArgs: string[]
  let startupCommandDeliveredInShellArgs = false
  let windowsFallbackAttempts: WindowsShellSpawnAttempt[] = []
  const startupAgentRecognition = recognizeAgentProcessFromCommandLine(opts.command)
  const isCodexStartupCommand = startupAgentRecognition?.agent === 'codex'
  if (opts.command && startupAgentRecognition) {
    assertSafeAgentStartupCwd(opts.cwd, opts.command)
  }
  const requestedCwd = opts.cwd || getDefaultCwd()
  let spawnCwd = requestedCwd
  let validationCwd = spawnCwd

  if (process.platform === 'win32') {
    const normalizedShellFamily = pathWin32.basename(shellPath).toLowerCase()
    const resolvedGitBashPath = resolveWindowsGitBashShellPath(shellPath)
    // Why: normalize concrete PowerShell paths to the family so the resolver can fall back to powershell.exe when pwsh.exe is unavailable.
    const resolvedShellFamily: WindowsPowerShellShellFamily =
      normalizedShellFamily === 'powershell.exe' || normalizedShellFamily === 'pwsh.exe'
        ? normalizedShellFamily
        : normalizedShellFamily === 'cmd.exe' || normalizedShellFamily === 'wsl.exe'
          ? normalizedShellFamily
          : undefined
    const shouldProbePwsh = shouldProbeWindowsPowerShellAvailability({
      shellFamily: resolvedShellFamily,
      implementation: opts.terminalWindowsPowerShellImplementation
    })
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
            shellFamily: resolvedShellFamily,
            implementation: opts.terminalWindowsPowerShellImplementation,
            pwshAvailable: shouldProbePwsh ? isPwshAvailable() : false
          }) ?? shellPath)
        : shellPath
    }
    // Why: a bare `pwsh.exe` resolves to the Store App Execution Alias stub whose launch fails with ERROR_ACCESS_DENIED (5).
    windowsFallbackAttempts = buildWindowsPowerShellSpawnAttempts({
      shellPath,
      cwd: spawnCwd,
      defaultCwd: getDefaultCwd(),
      wslContext: resolvedWslContext,
      startupCommand: opts.command
    })
    const primaryAttempt = windowsFallbackAttempts[0]
    if (primaryAttempt) {
      shellPath = primaryAttempt.shellPath
      shellArgs = primaryAttempt.shellArgs
      spawnCwd = primaryAttempt.effectiveCwd
      validationCwd = primaryAttempt.validationCwd
      startupCommandDeliveredInShellArgs = primaryAttempt.startupCommandDeliveredInShellArgs
    } else {
      const resolved = resolveWindowsShellLaunchArgs(
        shellPath,
        spawnCwd,
        getDefaultCwd(),
        resolvedWslContext,
        opts.command
      )
      shellArgs = resolved.shellArgs
      spawnCwd = resolved.effectiveCwd
      validationCwd = resolved.validationCwd
      startupCommandDeliveredInShellArgs = resolved.startupCommandDeliveredInShellArgs === true
    }
    if (isWindowsGitBashShellPath(shellPath)) {
      // Why: Git for Windows login startup files otherwise cd to $HOME, ignoring node-pty's cwd.
      env.CHERE_INVOKING ??= '1'
    }
    const codexHomeWslInfo = env.CODEX_HOME ? parseWslPath(env.CODEX_HOME) : null
    if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
      if (codexHomeWslInfo) {
        const launchWslDistro = resolvedWslContext?.distro
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
              },
              opts.command
            )
            shellArgs = resolved.shellArgs
            spawnCwd = resolved.effectiveCwd
            validationCwd = resolved.validationCwd
            startupCommandDeliveredInShellArgs =
              resolved.startupCommandDeliveredInShellArgs === true
          }
        }
      } else if (isHostCodexHomeForWsl(env.CODEX_HOME)) {
        // Why: host-local Codex home is unusable in WSL; let WSL Codex use its Linux-side ~/.codex.
        delete env.CODEX_HOME
        delete env.ORCA_CODEX_HOME
      } else if (env.CODEX_HOME) {
        addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
      }
      if (env.CLAUDE_CONFIG_DIR) {
        // Why: non-default env vars need WSLENV import to cross Windows wsl.exe into the Linux side.
        addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
      }
      if (env[ORCA_HERMES_STARTUP_QUERY_ENV] !== undefined) {
        // Why: wsl.exe drops custom Windows env vars unless named in WSLENV.
        addWslEnvKeys(env, [ORCA_HERMES_STARTUP_QUERY_ENV])
      }
    } else if (codexHomeWslInfo || isWslCodexHomeForHost(env.CODEX_HOME)) {
      // Why: WSL Codex homes are Linux paths; also drop ORCA_CODEX_HOME since shell-ready restores CODEX_HOME from it.
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    }
    if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
      addOrcaWslInteropEnv(env)
    }
  } else {
    // Why: relay-side launch modes can ask for host defaults to stay scrubbed
    // even after environment normalization above.
    deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
    if (opts.env?.TERM) {
      env.TERM = opts.env.TERM
    }
    // Why: set SHELL after the scrub and before launch-config derivation so shell-ready wrappers target the resolved shell.
    const preferredShellPath = shellPath
    shellPath = resolveUnixShellPath(shellPath)
    if (shellPath !== preferredShellPath) {
      env.SHELL = shellPath
      console.warn(
        `[daemon/pty] Preferred shell "${preferredShellPath}" is unavailable, fell back to "${shellPath}"`
      )
    }
    // Why: OpenCode/Codex path restoration and OMP's typed-command status wrapper need shell-ready code after user startup files run.
    let shellLaunch: ReturnType<typeof getShellReadyLaunchConfig> | null = null
    if (opts.command && isCodexStartupCommand) {
      const shouldWaitForShellReady = shouldUseShellReadyStartupDelivery({
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery
      })
      // Why: payload-bearing Codex startup text can be dropped by rc-file noise; plain Codex stays markerless for the startup-speed path.
      shellLaunch = shouldWaitForShellReady
        ? getShellReadyLaunchConfig(shellPath)
        : getAttributionShellLaunchConfig(shellPath)
    } else if (opts.command) {
      shellLaunch = getShellReadyLaunchConfig(shellPath)
    } else {
      shellLaunch =
        env.ORCA_ATTRIBUTION_SHIM_DIR ||
        env.ORCA_OPENCODE_CONFIG_DIR ||
        env.ORCA_MIMOCODE_HOME ||
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
  seedPowerlevel10kWizardEnv(env, { envToDelete: opts.envToDelete })
  if (
    env[POWERLEVEL10K_WIZARD_DISABLE_ENV] !== undefined &&
    process.platform === 'win32' &&
    pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe'
  ) {
    addWslEnvKeys(env, [POWERLEVEL10K_WIZARD_DISABLE_ENV])
  }
  promoteAgentTeamsShimPath(env, opts.env?.PATH)

  // Why: asar packaging can strip +x from node-pty's spawn-helper; the daemon is a separate forked process from the main-process fix.
  ensureNodePtySpawnHelperExecutable()
  preflightUnixPtySpawnEnvironment()
  preflightPosixPtySpawnEnvironment(validationCwd)
  preflightWindowsPtySpawnEnvironment({
    validationCwd,
    cwdWasExplicit: opts.cwd !== undefined
  })

  let proc: pty.IPty
  try {
    const spawned = spawnDaemonPtyWithWindowsFallback({
      shellPath,
      shellArgs,
      spawnCwd,
      env,
      cols: size.cols,
      rows: size.rows,
      windowsFallbackAttempts
    })
    proc = spawned.process
    // Why: a Windows fallback (e.g. cmd.exe) carries its own argv-embedded startup command; adopt the winning shell's identity + delivery flag.
    shellPath = spawned.shellPath
    spawnCwd = spawned.spawnCwd
    if (spawned.startupCommandDeliveredInShellArgs !== undefined) {
      startupCommandDeliveredInShellArgs = spawned.startupCommandDeliveredInShellArgs
    }
  } catch (err) {
    if (process.platform === 'win32') {
      throw formatPtySpawnError(err, shellPath, spawnCwd)
    }
    throw err
  }

  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  let pendingPreListenerData: string[] = []
  let pendingPreListenerDataChars = 0
  let pendingPreListenerExitCode: number | null = null

  const bufferPreListenerData = (data: string): void => {
    // Why: Windows shell-arg startup commands can print before Session wires this subprocess in; preserve that spawn-time race window.
    pendingPreListenerData.push(data)
    pendingPreListenerDataChars += data.length
    while (pendingPreListenerDataChars > PENDING_PRE_LISTENER_DATA_MAX_CHARS) {
      const removed = pendingPreListenerData.shift()
      if (removed === undefined) {
        pendingPreListenerDataChars = 0
        return
      }
      pendingPreListenerDataChars -= removed.length
    }
  }

  const flushPreListenerData = (): void => {
    if (!onDataCb || pendingPreListenerData.length === 0) {
      return
    }
    const pending = pendingPreListenerData
    pendingPreListenerData = []
    pendingPreListenerDataChars = 0
    for (const data of pending) {
      onDataCb(data)
    }
  }

  let lastOutputAt = 0
  proc.onData((data) => {
    if (data.length > 0) {
      lastOutputAt = Date.now()
    }
    if (onDataCb) {
      onDataCb(data)
    } else {
      bufferPreListenerData(data)
    }
  })
  proc.onExit(({ exitCode }) => {
    if (onExitCb) {
      flushPreListenerData()
      onExitCb(exitCode)
    } else {
      pendingPreListenerExitCode = exitCode
    }
  })

  // Why: node-pty throws Napi::Error if write/resize/kill hit a closed fd (child-exit vs onExit race); uncaught it std::terminates the daemon.
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
    (isShellProcess(fallbackProcess) ||
      isAgentForegroundWrapperProcess(fallbackProcess) ||
      shouldInspectOuterWrapperFallback(fallbackProcess) ||
      // Why: agent-spawned helpers can become the PTY foreground child, but the Unix process tree still identifies the parent agent.
      process.platform !== 'win32')
  const scheduleAgentForegroundRefresh = (fallbackProcess: string | null): void => {
    if (dead || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !shouldInspectFallbackForegroundProcess(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgentForeground(now) && !cachedAgentForeground
    // Why: on Windows each refresh is a whole-table CIM scan, so only shells with no agent evidence and no recent output relax the retry.
    const retryMs = !idleNoEvidenceShell
      ? FOREGROUND_AGENT_CACHE_TTL_MS
      : process.platform === 'win32' && now - lastOutputAt > SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS
        ? WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS
        : SHELL_FOREGROUND_REFRESH_RETRY_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    // Why: daemon foreground reads are sync on the IPC hot path; refresh derived identities in the background and serve from a short cache.
    // Why: Windows may need an async membership check before this shell/wrapper retirement policy is safe.
    const retireStaleForegroundIdentity = (): void => {
      const currentFallbackProcess = getFallbackForegroundProcess()
      if (
        fallbackIsShell &&
        !getActiveStartupAgentForeground() &&
        currentFallbackProcess !== null &&
        isShellProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
        startupAgentForeground = null
      } else if (
        cachedAgentForeground !== null &&
        Date.now() - cachedAgentForeground.refreshedAt > FOREGROUND_AGENT_CACHE_TTL_MS &&
        currentFallbackProcess !== null &&
        isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        // Why: an expired wrapper identity must not transfer to an unrelated wrapper (e.g. npm after an agent exit); fresh ones survive scan hiccups.
        cachedAgentForeground = null
      }
    }
    void resolveAgentForegroundProcessWithAvailability(proc.pid, fallbackProcess, {
      contextPaths: agentForegroundContextPaths
    })
      .then<string | void>(({ processName, available }) => {
        if (dead) {
          return
        }
        // Why: a degraded scan isn't exit evidence — retiring would fire false completion while the agent works under CIM load.
        if (!available) {
          return
        }
        if (!processName || !recognizeAgentProcess(processName)) {
          // Why: a Windows snapshot can omit a live agent; only verified shell-only membership may retire cached identity.
          if (process.platform === 'win32' && fallbackIsShell && cachedAgentForeground !== null) {
            return readWindowsConptyProcessIds(proc.pid).then((consoleProcessIds) => {
              if (dead || consoleProcessIds === null || consoleProcessIds.size > 1) {
                return
              }
              retireStaleForegroundIdentity()
            })
          }
          retireStaleForegroundIdentity()
          return
        }
        cachedAgentForeground = { processName, refreshedAt: Date.now() }
        startupAgentForeground = null
        return processName
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
    // Why: neutralize proc.kill synchronously in onExit so UnixTerminal's async socket-close SIGHUP can't land on a recycled pid.
    // Windows excluded: WindowsTerminal.destroy needs kill() to close the ConPTY agent.
    if (process.platform !== 'win32') {
      ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
    }
  })

  return {
    pid: proc.pid,
    shellPath,
    ...(startupCommandDeliveredInShellArgs ? { startupCommandDeliveredInShellArgs: true } : {}),
    getForegroundProcess: () => {
      // Why: node-pty's `.process` reports the live foreground name but reads a recycled pid on a reaped pty, so bail when dead.
      if (dead) {
        return null
      }
      try {
        const fallbackProcess = getFallbackForegroundProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        const inspectOuterWrapper =
          fallbackRecognition !== null &&
          shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
        if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
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
        // Why: a wrapper (node/python) can't self-identify and readers poll slower than the cache TTL, so serve the last resolved agent.
        // On Windows a shell fallback is an unreliable exit signal under ConPTY lag; trust the cache until a console-presence read confirms exit.
        if (
          cachedAgentForeground &&
          fallbackProcess !== null &&
          (isAgentForegroundWrapperProcess(fallbackProcess) ||
            inspectOuterWrapper ||
            (process.platform === 'win32' && isShellProcess(fallbackProcess)))
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
    confirmForegroundProcess: async () => {
      if (dead || !proc.pid) {
        return null
      }
      try {
        const fallbackProcess = getFallbackForegroundProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        if (
          !fallbackProcess ||
          (fallbackRecognition !== null &&
            process.platform !== 'win32' &&
            !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
          (process.platform !== 'win32' && !shouldInspectFallbackForegroundProcess(fallbackProcess))
        ) {
          return fallbackProcess
        }
        // Why: cached/in-flight scans may predate the OSC command boundary; confirmation needs a snapshot started afterward.
        const resolution = await resolveAgentForegroundProcessWithAvailability(
          proc.pid,
          fallbackProcess,
          {
            contextPaths: agentForegroundContextPaths,
            fresh: true,
            ...(process.platform === 'win32'
              ? {
                  forceProcessScan: true,
                  readWindowsConptyProcessIds: () => readWindowsConptyProcessIds(proc.pid)
                }
              : {})
          }
        )
        if (dead || !resolution.available) {
          return null
        }
        const recognized = recognizeAgentProcess(resolution.processName)
        if (recognized) {
          cachedAgentForeground = {
            processName: recognized.processName,
            refreshedAt: Date.now()
          }
          startupAgentForeground = null
          return recognized.processName
        }
        // Why: a post-boundary scan resolving no agent is the authority that retires stale cached/startup identity.
        cachedAgentForeground = null
        startupAgentForeground = null
        return resolution.processName
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
    // Why pause/resume work on Windows too: WindowsTerminal wires _socket to the ConPTY conout pipe, so pausing backpressures the child.
    pause: () => {
      if (dead) {
        return
      }
      try {
        proc.pause()
      } catch {
        /* native handle already torn down — flow control is best-effort */
      }
    },
    resume: () => {
      if (dead) {
        return
      }
      try {
        proc.resume()
      } catch {
        /* native handle already torn down — flow control is best-effort */
      }
    },
    clear: () => {
      if (dead) {
        return
      }
      try {
        proc.clear()
      } catch {
        // Best-effort: a clear on a just-exited PTY must not kill the handle.
      }
    },
    kill: () => {
      if (dead) {
        return
      }
      nodePtyKillIssued = true
      try {
        proc.kill()
      } catch (error) {
        // Why: a rejected native kill isn't proof of exit — keep the wrapper live so Session can retry the owner.
        nodePtyKillIssued = false
        throw error
      }
    },
    forceKill: () => {
      // Why: after reap/dispose proc.pid is a recycled pid, so SIGKILL would hit an unrelated process (forceKill only signals a live child).
      // Why: Windows node-pty kill already closed ConPTY; forcing again can double-close the native handle.
      if (dead || (process.platform === 'win32' && nodePtyKillIssued)) {
        return
      }
      try {
        forceKillPosixPtyProcessGroups(proc.pid, () => {
          process.kill(proc.pid, 'SIGKILL')
        })
      } catch (signalError) {
        try {
          proc.kill()
          nodePtyKillIssued = true
        } catch {
          nodePtyKillIssued = false
          // Keep the original OS failure so callers can retry the same owner.
          throw signalError
        }
      }
    },
    signal: (sig) => {
      // Why: same recycled-pid hazard as forceKill — once dead, dropping avoids signalling an unrelated process.
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
      flushPreListenerData()
    },
    onExit: (cb) => {
      onExitCb = cb
      if (pendingPreListenerExitCode !== null) {
        const code = pendingPreListenerExitCode
        pendingPreListenerExitCode = null
        flushPreListenerData()
        cb(code)
      }
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      dead = true
      onDataCb = null
      onExitCb = null
      pendingPreListenerData = []
      pendingPreListenerDataChars = 0
      pendingPreListenerExitCode = null
      // Why: UnixTerminal.destroy()'s async socket-close SIGHUP can land on a recycled pid, hitting an unrelated user process; neutralize kill on POSIX.
      // Windows destroy() uses kill() to close the ConPTY agent, so the guard is POSIX-only.
      if (process.platform !== 'win32') {
        ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
      } else if (nodePtyKillIssued) {
        // Why: WindowsTerminal.destroy() calls kill(); destroying after node-pty's kill() double-closes the ConPTY handle (heap corruption).
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
