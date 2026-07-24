/* eslint-disable max-lines -- command routing, WSL translation, and git/gh/glab wrappers stay co-located for consistent platform behavior. */
/**
 * Centralized git/gh/command runner with transparent WSL support.
 *
 * Why: when a repo lives on a WSL filesystem, native Windows binaries (git.exe,
 * gh.exe, rg.exe) are absent or slow, so this routes execution through
 * `wsl.exe -d <distro>` with translated Linux paths.
 */
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions
} from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { withGitSpan } from '../observability/instrumentation'
import { recordSubprocessSpawn } from '../diagnostics/main-thread-churn-probe'
import {
  classifyGhRateLimitBucket,
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  ghRateLimitScopeKey,
  isGhPrimaryRateLimitStderr,
  isGhRateLimitProbe,
  notifyGhPrimaryRateLimit,
  type GhRateLimitBucket
} from './gh-rate-limit-breaker'
import { getDefaultWslDistro, parseWslPath, toWindowsWslPath, type WslPathInfo } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'
import {
  appendGitConfigEnv,
  gitCredentialPromptGuardEnv
} from '../../shared/git-credential-prompt-env'
import { getSpawnArgsForWindows, isWindowsBatchScript, resolveWindowsCommand } from '../win32-utils'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../shared/git-output-locale'
import { endSubprocessStdin } from '../../shared/subprocess-stdin-write'
// Re-exported for existing importers; lightweight consumers should import from './exec-error' to avoid this heavy module.
import { extractExecError, parseRetryAfterMs } from './exec-error'
export { extractExecError, parseRetryAfterMs }

// ─── Core resolution ────────────────────────────────────────────────

// Env-assignment prefix for WSL-routed git, where spawn env can't cross the wsl.exe boundary; values are shell-safe unquoted.
const GIT_OUTPUT_LOCALE_SHELL_PREFIX = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV)
  .map(([key, value]) => `${key}=${value}`)
  .join(' ')

type ResolvedCommand = {
  binary: string
  args: string[]
  cwd: string | undefined
  /** Non-null when the command was routed through WSL. */
  wsl: WslPathInfo | null
}

/**
 * Translate Windows-style path arguments to Linux paths for commands run in WSL.
 *
 * Why: callers pass Windows paths as git arguments, which WSL git can't read.
 * UNC paths (\\wsl.localhost\…) become native Linux; drive paths (C:\…) → /mnt/c/…
 */
function translateArgsForWsl(args: string[]): string[] {
  return args.map(translateArgForWsl)
}

function translateArgForWsl(arg: string): string {
  // WSL UNC path → native linux path
  const wslInfo = parseWslPath(arg)
  if (wslInfo) {
    return wslInfo.linuxPath
  }

  // Windows drive path (e.g. C:\Users\...) → /mnt/c/Users/...
  const driveMatch = arg.match(/^([A-Za-z]):[/\\](.*)$/)
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase()
    const rest = driveMatch[2].replace(/\\/g, '/')
    return `/mnt/${driveLetter}/${rest}`
  }

  return arg
}

function hasExplicitRepoArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (
      (args[i] === '--repo' || args[i] === '-R') &&
      typeof args[i + 1] === 'string' &&
      args[i + 1].trim()
    ) {
      return true
    }
    if (args[i].startsWith('--repo=') || args[i].startsWith('-R=')) {
      return args[i].slice(args[i].indexOf('=') + 1).trim().length > 0
    }
    if (args[i].startsWith('-R') && args[i].length > 2) {
      return args[i].slice(2).trim().length > 0
    }
  }
  return false
}

function argsUseGhApiPlaceholders(args: string[]): boolean {
  return args.some(
    (arg) => arg.includes('{owner}') || arg.includes('{repo}') || arg.includes('{branch}')
  )
}

function hasExplicitRepoViewTarget(args: string[]): boolean {
  const target = args[2]
  return (
    args[0] === 'repo' &&
    args[1] === 'view' &&
    typeof target === 'string' &&
    !target.startsWith('-') &&
    target.includes('/')
  )
}

function canRunGitHubCliWithoutRepoCwd(args: string[]): boolean {
  if (hasExplicitRepoArg(args)) {
    return true
  }
  if (args[0] === 'api') {
    return !argsUseGhApiPlaceholders(args)
  }
  return args[0] === 'auth' || hasExplicitRepoViewTarget(args)
}

function isMissingCommandInWsl(stderr: string, command: string): boolean {
  const s = stderr.toLowerCase()
  const c = command.toLowerCase()
  return s.includes(`${c}: command not found`) || s.includes(`${c}: not found`)
}

function canFallBackToHostGitHubCli(
  command: 'gh',
  args: string[],
  resolved: ResolvedCommand,
  stderr: string
): boolean {
  return (
    process.platform === 'win32' &&
    resolved.wsl !== null &&
    isMissingCommandInWsl(stderr, command) &&
    canRunGitHubCliWithoutRepoCwd(args)
  )
}

function resolveHostGitHubCli(command: 'gh', args: string[]): ResolvedCommand {
  return {
    binary: command,
    args,
    // Why: host gh can't use a WSL UNC cwd; we only fall back for commands with explicit repo/API context, so none is needed.
    cwd: undefined,
    wsl: null
  }
}

function resolveDefaultWslCli(command: 'gh' | 'glab', args: string[]): ResolvedCommand | null {
  const distro = getDefaultWslDistro()
  return distro ? resolveCommand(command, args, undefined, distro) : null
}

function isHostCommandMissing(err: unknown, command: 'gh' | 'glab'): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const e = err as { code?: unknown; message?: unknown; syscall?: unknown; path?: unknown }
  if (e.code === 'ENOENT') {
    return true
  }
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return (
    message.includes('enoent') &&
    (message.includes(command) || e.path === command || e.syscall === 'spawn')
  )
}

/**
 * Resolve whether a command invocation should be routed through wsl.exe.
 *
 * Why `bash -c "cd … && …"` instead of `--cd`: wsl.exe's --cd fails with
 * ERROR_PATH_NOT_FOUND under Node's execFile/spawn in some configs.
 */
function resolveCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  wslDistroOverride?: string,
  options: { useWslLoginShell?: boolean } = {}
): ResolvedCommand {
  if (process.platform !== 'win32') {
    return { binary: command, args, cwd, wsl: null }
  }

  // Why: global gh callers (rate_limit, listAccessibleProjects) have no cwd to derive a distro from; a distro hint still routes through wsl.exe.
  // TODO(wsl-default-distro): no default-distro setting yet, so override-less global gh callers fall back to host gh.exe (ENOENT on WSL-only installs).
  const cwdWsl = cwd ? parseWslPath(cwd) : null
  const wsl: WslPathInfo | null =
    cwdWsl ?? (wslDistroOverride ? { distro: wslDistroOverride, linuxPath: '' } : null)
  if (!wsl) {
    return { binary: command, args, cwd, wsl: null }
  }

  const translatedArgs = translateArgsForWsl(args)
  // Why: env on wsl.exe stays Windows-side (WSLENV forwards only named vars), so the locale must ride the command string (issue #7808).
  const localePrefix = command === 'git' ? `${GIT_OUTPUT_LOCALE_SHELL_PREFIX} ` : ''
  const escapedCommand = quotePosixShell(command)
  // Why: shell-escape each arg to prevent word splitting / glob expansion inside the bash -c string.
  const escapedArgs = translatedArgs.map(quotePosixShell)
  // Why: prepend `cd <linuxPath> &&` for a UNC cwd; skip it when only a distro override was given (global gh needs no cwd).
  const linuxCwd = cwdWsl?.linuxPath ?? (cwd && wslDistroOverride ? translateArgForWsl(cwd) : null)
  const shellCmd = linuxCwd
    ? `cd ${quotePosixShell(linuxCwd)} && ${localePrefix}${escapedCommand} ${escapedArgs.join(' ')}`
    : `${localePrefix}${escapedCommand} ${escapedArgs.join(' ')}`

  if (options.useWslLoginShell) {
    return {
      binary: 'wsl.exe',
      args: [
        '-d',
        wsl.distro,
        '--',
        'sh',
        '-lc',
        escapeWslShCommandForWindows(buildWslLoginShellCommand(shellCmd))
      ],
      cwd: undefined,
      wsl
    }
  }

  return {
    binary: 'wsl.exe',
    args: ['-d', wsl.distro, '--', 'bash', '-c', shellCmd],
    // Why: the `cd` inside bash -c handles the directory; a UNC cwd on the Node process is redundant and can break Node internals.
    cwd: undefined,
    wsl
  }
}

// ─── Git-specific runners ───────────────────────────────────────────

// Why: execFile disables its cap when maxBuffer is undefined; unbounded output over V8's string max crashes main uncatchably — keep in sync with relay MAX_GIT_BUFFER.
export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024

type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  stdin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  wslDistro?: string
  useConfiguredSshCommandForNetwork?: boolean
}

type CommandExecOptions = {
  cwd?: string
  encoding?: BufferEncoding
  maxBuffer?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

function isMissingCommandError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

function shouldRetryWindowsCommandShim(error: unknown, resolved: ResolvedCommand): boolean {
  return (
    process.platform === 'win32' &&
    resolved.wsl === null &&
    isMissingCommandError(error) &&
    !hasPathSeparator(resolved.binary) &&
    !/\.[A-Za-z0-9]+$/.test(resolved.binary)
  )
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const WINDOWS_TREE_KILL_WAIT_MS = 2_000

function killSpawnedCommandTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || process.platform !== 'win32') {
    child.kill()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      // Why: Windows shims/wsl.exe own descendants; wait for /t tree cleanup so a timed-out command can't outlive its probe.
      killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      if (!killer || typeof killer.unref !== 'function') {
        child.kill()
        resolve()
        return
      }
    } catch {
      child.kill()
      resolve()
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (fallbackToChildKill: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      killer.removeAllListeners()
      if (fallbackToChildKill) {
        child.kill()
      }
      resolve()
    }
    killer.once('error', () => finish(true))
    killer.once('close', (code) => finish(code !== 0))
    timer = setTimeout(() => {
      killer.kill()
      finish(true)
    }, WINDOWS_TREE_KILL_WAIT_MS)
    killer.unref()
  })
}

type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
  timeout?: number
  stdin?: string
}

function emptyExecFileOutput(options: ExecFileCaptureOptions): string | Buffer {
  return options.encoding === 'buffer' ? Buffer.alloc(0) : ''
}

function isExecFileResultObject(
  value: unknown
): value is { stdout: string | Buffer; stderr: string | Buffer } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    'stdout' in value &&
    'stderr' in value
  )
}

function execFileCapture(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError())
      return
    }

    let settled = false
    let terminating = false
    let child: ChildProcess | null = null
    let timer: NodeJS.Timeout | null = null
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (
      error: Error | null,
      stdout: string | Buffer = emptyExecFileOutput(options),
      stderr: string | Buffer = emptyExecFileOutput(options)
    ): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        const enriched = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
        enriched.stdout ??= stdout
        enriched.stderr ??= stderr
        reject(enriched)
        return
      }
      resolve({ stdout, stderr })
    }
    const onAbort = (): void => {
      if (settled || terminating) {
        return
      }
      terminating = true
      const abortError = createAbortError()
      if (!child) {
        terminating = false
        finish(abortError)
        return
      }
      void killSpawnedCommandTree(child).then(() => {
        terminating = false
        finish(abortError)
      })
    }

    try {
      const spawnStartedAt = performance.now()
      // Why: our abort listener owns tree cleanup; Node's signal handler could kill wsl.exe before taskkill sees its children.
      child = execFile(
        command,
        args,
        {
          cwd: options.cwd,
          encoding: options.encoding,
          maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
          env: options.env
        },
        (error, stdout, stderr) => {
          if (terminating) {
            return
          }
          if (!error && stderr === undefined && isExecFileResultObject(stdout)) {
            finish(null, stdout.stdout, stdout.stderr)
            return
          }
          finish(error, stdout, stderr)
        }
      )
      recordSubprocessSpawn(command, args, performance.now() - spawnStartedAt)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    child.once('error', (error) => {
      if (!terminating) {
        finish(error)
      }
    })

    if (options.stdin !== undefined) {
      endSubprocessStdin(child.stdin, options.stdin)
    }

    // Why: Node's timeout waits forever on signal-ignoring CLIs; enforce our own deadline with bounded tree cleanup.
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        if (settled || terminating) {
          return
        }
        terminating = true
        const timeoutError = new Error(`${command} timed out.`)
        if (!child) {
          terminating = false
          finish(timeoutError)
          return
        }
        void killSpawnedCommandTree(child).then(() => {
          terminating = false
          finish(timeoutError)
        })
      }, options.timeout)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function spawnCommandCapture(
  command: string,
  args: string[],
  options: CommandExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError())
      return
    }
    let settled = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const spawnStartedAt = performance.now()
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    recordSubprocessSpawn(spawnCmd, spawnArgs, performance.now() - spawnStartedAt)
    let timer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      void killSpawnedCommandTree(child)
      finish(createAbortError())
    }
    const cleanupListeners = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onStdoutData)
      child.stderr?.off('data', onStderrData)
      child.off('error', onError)
      child.off('close', onClose)
    }
    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    }
    timer = options.timeout
      ? setTimeout(() => {
          void killSpawnedCommandTree(child)
          finish(new Error(`${command} timed out.`))
        }, options.timeout)
      : null
    options.signal?.addEventListener('abort', onAbort, { once: true })
    function onStdoutData(chunk: Buffer): void {
      stdoutBytes += chunk.byteLength
      if (options.maxBuffer && stdoutBytes > options.maxBuffer) {
        void killSpawnedCommandTree(child)
        finish(new Error(`${command} stdout exceeded maxBuffer.`))
        return
      }
      stdout += chunk.toString(options.encoding ?? 'utf-8')
    }
    function onStderrData(chunk: Buffer): void {
      stderrBytes += chunk.byteLength
      if (options.maxBuffer && stderrBytes > options.maxBuffer) {
        void killSpawnedCommandTree(child)
        finish(new Error(`${command} stderr exceeded maxBuffer.`))
        return
      }
      stderr += chunk.toString(options.encoding ?? 'utf-8')
    }
    function onError(error: Error): void {
      finish(error)
    }
    function onClose(code: number | null): void {
      if (code === 0) {
        finish(null)
        return
      }
      finish(new Error(`${command} exited with ${code}.`))
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
  })
}

export function gitOptionalLocksDisabledEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  }
}

/**
 * Append git config via the GIT_CONFIG_COUNT/KEY_n/VALUE_n env protocol (git >= 2.31),
 * composing with any count already in `env` so we never clobber a caller's config.
 */
export { appendGitConfigEnv }

/**
 * Pin Orca-spawned git to untranslated English output so stderr/progress parsers
 * work under any user locale (issue #7808). Terminal git is untouched.
 */
export function untranslatedGitOutputEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...UNTRANSLATED_GIT_OUTPUT_ENV }
}

export function promptGuardGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return gitCredentialPromptGuardEnv(untranslatedGitOutputEnv(env), platform)
}

/**
 * Credential-prompt guard for a general-purpose shell (PTYs, hook scripts):
 * like promptGuardGitEnv but without the issue-7808 locale pins, which would
 * change the locale of every child process, not just git's.
 */
export function promptGuardShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return gitCredentialPromptGuardEnv(env, platform)
}

/**
 * Force git non-interactive so it fails fast instead of hanging on a prompt with
 * no terminal to answer it; on headless `serve` those stuck calls wedge every
 * client (issue #5308).
 *
 * - GIT_TERMINAL_PROMPT=0: git errors instead of prompting for credentials.
 * - GIT_ASKPASS / SSH_ASKPASS: emptied when unset so no GUI helper blocks; a
 *   caller-provided askpass is preserved (custom setups serve creds non-interactively).
 * - GIT_SSH_COMMAND BatchMode=yes: SSH errors instead of prompting (doesn't change
 *   host trust); only added when the caller hasn't set its own.
 */
export function nonInteractiveGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const next = promptGuardGitEnv(env, platform)
  if (!next.GIT_SSH_COMMAND) {
    next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
    if (platform === 'win32') {
      // Why: forward GIT_SSH_COMMAND to WSL only when we set it — a caller's Windows-specific value must not leak into Linux git.
      addWslEnvKeys(next, ['GIT_SSH_COMMAND'])
    }
  }
  return next
}

type GitSshPolicyMode =
  | 'default'
  | 'explicit-env'
  | 'fallback'
  | 'configured-openssh'
  | 'configured-wrapper-passthrough'

const CORE_SSH_COMMAND_PROBE_TIMEOUT_MS = 2500

function commandBasename(command: string): string {
  const pieces = command.split(/[\\/]+/)
  return pieces.at(-1)?.toLowerCase() ?? command.toLowerCase()
}

function isMergeableOpenSshCommand(command: string): boolean {
  const basename = commandBasename(command)
  return basename === 'ssh' || basename === 'ssh.exe'
}

function shellTokenize(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      const next = command[i + 1]
      if (next && /[\s'"\\]/.test(next)) {
        escaped = true
      } else {
        current += char
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    if (';&|<>()`'.includes(char)) {
      return null
    }
    current += char
  }

  if (escaped || quote) {
    return null
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function shellQuoteToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(token) ? token : quotePosixShell(token)
}

function containsShellExpansionSyntax(command: string): boolean {
  return command.includes('$')
}

function withoutBatchModeOptions(tokens: string[]): string[] {
  const next: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()
    if (lower === '-o') {
      const option = tokens[i + 1]?.toLowerCase()
      if (option?.startsWith('batchmode')) {
        i += 1
        continue
      }
    }
    if (lower.startsWith('-obatchmode')) {
      continue
    }
    next.push(token)
  }
  return next
}

function buildOpenSshBatchModeCommand(configuredCommand: string): string | null {
  if (containsShellExpansionSyntax(configuredCommand)) {
    return null
  }
  const tokens = shellTokenize(configuredCommand)
  if (!tokens || tokens.length === 0 || !isMergeableOpenSshCommand(tokens[0])) {
    return null
  }
  return [...withoutBatchModeOptions(tokens), '-o', 'BatchMode=yes'].map(shellQuoteToken).join(' ')
}

async function buildNetworkSshPolicyEnv(options: GitExecOptions): Promise<{
  env: NodeJS.ProcessEnv
  mode: GitSshPolicyMode
}> {
  const promptEnv = promptGuardGitEnv(options.env)
  if (promptEnv.GIT_SSH_COMMAND) {
    return { env: promptEnv, mode: 'explicit-env' }
  }

  const resolved = resolveCommand(
    'git',
    ['config', '--get', 'core.sshCommand'],
    options.cwd,
    options.wslDistro,
    { useWslLoginShell: Boolean(options.wslDistro) }
  )
  let configuredCommand = ''
  try {
    const { stdout } = await execFileCapture(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: 'utf-8',
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      timeout: CORE_SSH_COMMAND_PROBE_TIMEOUT_MS,
      env: promptEnv,
      signal: options.signal
    })
    configuredCommand = String(stdout).trim()
  } catch {
    configuredCommand = ''
  }

  if (!configuredCommand) {
    const env = { ...promptEnv, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
    // Why: WSL routing can come from either an explicit distro or a UNC cwd.
    if (resolved.wsl) {
      addWslEnvKeys(env, ['GIT_SSH_COMMAND'])
    }
    return { env, mode: 'fallback' }
  }

  const batchModeCommand = buildOpenSshBatchModeCommand(configuredCommand)
  if (!batchModeCommand) {
    // Why: custom SSH wrappers are user policy; rewriting their argv is riskier than relying on prompt guards + timeout.
    return { env: promptEnv, mode: 'configured-wrapper-passthrough' }
  }

  const env = { ...promptEnv, GIT_SSH_COMMAND: batchModeCommand }
  if (resolved.wsl) {
    addWslEnvKeys(env, ['GIT_SSH_COMMAND'])
  }
  return { env, mode: 'configured-openssh' }
}

/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
export async function gitExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  // Why: span the user-visible `git <subcommand>` form, not the resolved binary, so dashboards group by intent.
  return withGitSpan(
    { args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
    async () => {
      const resolved = resolveCommand('git', args, options.cwd, options.wslDistro, {
        useWslLoginShell: Boolean(options.wslDistro)
      })
      const policy = options.useConfiguredSshCommandForNetwork
        ? await buildNetworkSshPolicyEnv(options)
        : { env: nonInteractiveGitEnv(options.env), mode: 'default' as const }
      let result: { stdout: string | Buffer; stderr: string | Buffer }
      try {
        result = await execFileCapture(resolved.binary, resolved.args, {
          cwd: resolved.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          timeout: options.timeout,
          stdin: options.stdin,
          // Why: never let a git read-path call block on an interactive prompt (issue #5308) — fail fast.
          env: policy.env,
          signal: options.signal
        })
      } catch (error) {
        if (options.useConfiguredSshCommandForNetwork && error && typeof error === 'object') {
          Object.assign(error, { gitSshPolicyMode: policy.mode })
        }
        throw error
      }
      const { stdout, stderr } = result
      return { stdout: stdout as string, stderr: stderr as string }
    }
  )
}

/**
 * Async command execution with the same WSL cwd translation as repo-scoped git.
 * Keep this for fixed binary+argv call sites; never pass shell fragments.
 */
export async function commandExecFileAsync(
  command: string,
  args: string[],
  options: CommandExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveCommand(command, args, options.cwd)
  const binary =
    resolved.wsl === null ? resolveWindowsCommand(resolved.binary, options.env) : resolved.binary
  if (isWindowsBatchScript(binary)) {
    return spawnCommandCapture(binary, resolved.args, {
      ...options,
      cwd: resolved.cwd
    })
  }
  try {
    const { stdout, stderr } = await execFileCapture(binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
      env: options.env,
      signal: options.signal
    })
    return { stdout: stdout as string, stderr: stderr as string }
  } catch (error) {
    if (shouldRetryWindowsCommandShim(error, resolved)) {
      return spawnCommandCapture(
        resolveWindowsCommand(`${resolved.binary}.cmd`, options.env),
        resolved.args,
        {
          ...options,
          cwd: resolved.cwd
        }
      )
    }
    throw error
  }
}

/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
export async function gitExecFileAsyncBuffer(
  args: string[],
  options: { cwd: string; maxBuffer?: number; wslDistro?: string }
): Promise<{ stdout: Buffer }> {
  const resolved = resolveCommand('git', args, options.cwd, options.wslDistro, {
    useWslLoginShell: Boolean(options.wslDistro)
  })
  const { stdout } = (await execFileCapture(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: 'buffer',
    maxBuffer: options.maxBuffer,
    env: untranslatedGitOutputEnv()
  })) as { stdout: Buffer }
  return { stdout }
}

/** Result of a streamed git command; `stoppedEarly` is true when onStdout asked to stop before the child exited. */
export type GitStreamResult = { stoppedEarly: boolean }

type GitStreamOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  signal?: AbortSignal
  /** Byte backstop; defaults to DEFAULT_GIT_MAX_BUFFER. */
  maxBuffer?: number
  /**
   * Called for each decoded stdout chunk. Return true to stop: the child is
   * killed and the promise resolves with stoppedEarly=true.
   */
  onStdout: (chunk: string) => boolean | void
}

/**
 * Stream a git command's stdout incrementally instead of buffering it whole.
 *
 * Why: output larger than V8's max string (e.g. status on a repo with a huge
 * un-ignored folder) crashes the process when buffered; streaming keeps memory
 * bounded and lets the parser stop git early. Built on gitSpawn for WSL routing.
 */
export async function gitStreamStdout(
  args: string[],
  options: GitStreamOptions
): Promise<GitStreamResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER
  return withGitSpan({ args, cwd: options.cwd }, async () => {
    return new Promise<GitStreamResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError())
        return
      }
      const child = gitSpawn(args, {
        cwd: options.cwd,
        env: nonInteractiveGitEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        wslDistro: options.wslDistro,
        windowsHide: true
      })

      let settled = false
      let stoppedEarly = false
      let stdoutBytes = 0
      let stderr = ''
      let stderrBytes = 0
      // Why: decode statefully so a multibyte UTF-8 char split across chunks isn't corrupted into replacement chars.
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')

      const cleanup = (): void => {
        child.stdout?.off('data', onStdoutData)
        child.stderr?.off('data', onStderrData)
        child.off('error', onError)
        child.off('close', onClose)
        options.signal?.removeEventListener('abort', onAbort)
        // Flush any bytes the decoders were holding for an incomplete sequence.
        stdoutDecoder.end()
        stderrDecoder.end()
      }
      const finish = (error: Error | null): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (error) {
          reject(Object.assign(error, { stderr }))
          return
        }
        resolve({ stoppedEarly })
      }

      function onStdoutData(chunk: Buffer): void {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > maxBuffer) {
          void killSpawnedCommandTree(child)
          finish(new Error('git stdout exceeded maxBuffer.'))
          return
        }
        const decoded = stdoutDecoder.write(chunk)
        if (decoded.length === 0) {
          return
        }
        // Why: a throw from the caller's parser would escape this event handler and crash main; convert to a rejection.
        let shouldStop: boolean | void
        try {
          shouldStop = options.onStdout(decoded)
        } catch (error) {
          void killSpawnedCommandTree(child)
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (shouldStop === true) {
          // Parser hit its limit: kill git and resolve cleanly with the partial output.
          stoppedEarly = true
          void killSpawnedCommandTree(child)
          finish(null)
        }
      }
      function onStderrData(chunk: Buffer): void {
        stderrBytes += chunk.byteLength
        if (stderrBytes > maxBuffer) {
          void killSpawnedCommandTree(child)
          finish(new Error('git stderr exceeded maxBuffer.'))
          return
        }
        stderr += stderrDecoder.write(chunk)
      }
      function onError(error: Error): void {
        finish(error)
      }
      function onClose(code: number | null): void {
        if (stoppedEarly || code === 0) {
          finish(null)
          return
        }
        finish(new Error(`git exited with ${code}: ${stderr}`))
      }
      function onAbort(): void {
        if (!child.pid) {
          // Why: failed spawn reports ENOENT after abort cleanup; retain a listener so it cannot crash main.
          child.once('error', () => {})
        }
        void killSpawnedCommandTree(child)
        finish(createAbortError())
      }

      child.stdout?.on('data', onStdoutData)
      child.stderr?.on('data', onStderrData)
      child.on('error', onError)
      child.on('close', onClose)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        onAbort()
      }
    })
  })
}

// Why: sync git blocks the main thread; a dead network drive can hang git for minutes without a timeout (issue #7225's 127s freeze).
const GIT_EXEC_SYNC_TIMEOUT_MS = 15_000

/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
    timeout?: number
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  const spawnStartedAt = performance.now()
  try {
    return execFileSync(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      env: untranslatedGitOutputEnv(),
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? GIT_EXEC_SYNC_TIMEOUT_MS
    }) as string
  } finally {
    // Sync exec blocks the main thread for its whole duration — the cost issue #7576 flags.
    recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  }
}

/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
export function gitSpawn(
  args: string[],
  options: SpawnOptions & { cwd: string; wslDistro?: string }
): ChildProcess {
  const { wslDistro, ...spawnOptions } = options
  const resolved = resolveCommand('git', args, options.cwd, wslDistro, {
    useWslLoginShell: Boolean(wslDistro)
  })
  const spawnStartedAt = performance.now()
  const child = spawn(resolved.binary, resolved.args, {
    ...spawnOptions,
    env: untranslatedGitOutputEnv(spawnOptions.env ?? process.env),
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}

// ─── gh CLI runners ─────────────────────────────────────────────────

// `cwd?` omitted for non-repo-scoped gh calls (rate_limit, listAccessibleProjects) so one WSL-aware wrapper serves both.
// `wslDistro?` routes global cwd-less gh through `wsl.exe -d <distro>` on WSL-only Windows where gh.exe isn't on host PATH.
// `idempotent?` gates transient-error retry (auto-detected from argv); retrying a write that already reached GitHub would duplicate it.
type GhExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  // Why: `gh api` and `--repo OWNER/REPO` shorthand resolve against gh's
  // default host, not the repo's remote. Carrying the host here lets the
  // runner qualify every spawn once, so call sites can't silently fall back
  // to github.com for GHES repos; it also scopes the rate-limit breaker.
  host?: string
}

const NON_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
// `gh <noun> <verb>` write subcommands; reads are absent on purpose so they keep retrying.
const NON_IDEMPOTENT_GH_VERBS = new Set([
  'create',
  'edit',
  'update',
  'delete',
  'close',
  'reopen',
  'merge',
  'comment',
  'review',
  'ready',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'transfer',
  'develop'
])

function argsLookIdempotent(args: string[]): boolean {
  let explicitMethodSeen = false
  let hasApiBodyField = false
  let hasGraphQlQuery = false
  const isGraphQlApi = args[0] === 'api' && args[1] === 'graphql'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '--method') {
      explicitMethodSeen = true
      const next = args[i + 1]
      if (typeof next === 'string' && NON_IDEMPOTENT_METHODS.has(next.toUpperCase())) {
        return false
      }
    }
    // Single-token form `--method=POST` (gh accepts this).
    if (a.startsWith('--method=')) {
      explicitMethodSeen = true
      const value = a.slice('--method='.length)
      if (NON_IDEMPOTENT_METHODS.has(value.toUpperCase())) {
        return false
      }
    }
    // `gh api` auto-POSTs when -f/-F/--field body fields are given without -X; track them.
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      hasApiBodyField = true
    } else if (
      a.startsWith('-f=') ||
      a.startsWith('-F=') ||
      a.startsWith('--field=') ||
      a.startsWith('--raw-field=')
    ) {
      hasApiBodyField = true
    }
    // Detect GraphQL `query=mutation(…)` so endpoint writes also fail fast on transient errors.
    if (a.startsWith('query=')) {
      hasGraphQlQuery = true
      const trimmed = a.slice('query='.length).trimStart().toLowerCase()
      if (trimmed.startsWith('mutation')) {
        return false
      }
    }
  }
  // `gh api -f foo=bar` with no -X auto-POSTs → non-idempotent; GraphQL query bodies are the exception (still reads).
  if (
    args[0] === 'api' &&
    hasApiBodyField &&
    !explicitMethodSeen &&
    !(isGraphQlApi && hasGraphQlQuery)
  ) {
    return false
  }
  // `gh <noun> <verb>` writes (args[1]); `gh api` without -X defaults to idempotent GET, so it's excluded here.
  if (args.length >= 2 && args[0] !== 'api') {
    if (NON_IDEMPOTENT_GH_VERBS.has(args[1])) {
      return false
    }
  }
  return true
}

/**
 * Classify whether a gh execFile rejection is worth retrying.
 *
 * Why: gh surfaces HTTP status as stderr substrings ("HTTP 504", econnreset, …).
 * Retry 5xx/network resets and 429 only without Retry-After (propagate those so
 * the UI can show the wait); primary-rate-limit 403 is never transient.
 */
export function isTransientGhError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  if (
    s.includes('http 500') ||
    s.includes('http 502') ||
    s.includes('http 503') ||
    s.includes('http 504') ||
    s.includes('econnreset') ||
    s.includes('etimedout') ||
    s.includes('socket hang up')
  ) {
    return true
  }
  // 429 without Retry-After: retry. With Retry-After: propagate.
  if (s.includes('http 429')) {
    return parseRetryAfterMs(stderr) === null
  }
  return false
}

// Why: 3 attempts total (250ms → 1s backoff); array length defines retry count (total attempts = length + 1).
const GH_RETRY_DELAYS_MS = [250, 1000] as const

// Why: Retry-After is unbounded and untrusted; cap at 30s so a gh call can't block the IPC thread indefinitely.
const GH_RETRY_AFTER_MAX_MS = 30_000
const DEFAULT_GH_EXEC_TIMEOUT_MS = 30_000

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultGhExecTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_GH_EXEC_TIMEOUT_MS
  if (!raw) {
    return DEFAULT_GH_EXEC_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GH_EXEC_TIMEOUT_MS
}

function nonInteractiveGhEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_PROMPT_DISABLED: env.GH_PROMPT_DISABLED ?? '1'
  }
}

function hasGhHostnameFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--hostname' || arg.startsWith('--hostname='))
}

function hostQualifiedGhRepoValue(value: string, host: string): string {
  // URLs and already-qualified HOST/OWNER/REPO values pass through untouched.
  if (value.includes('://') || value.split('/').length !== 2) {
    return value
  }
  return `${host}/${value}`
}

/**
 * Host-qualify a gh invocation from `options.host`: `--hostname` for `api`
 * calls, `HOST/OWNER/REPO` for `--repo`/`-R` shorthand. SSH-backed repos run
 * gh with no cwd, so this is their only host signal (#8312).
 *
 * @internal exported for tests.
 */
export function applyGhHostToArgs(args: string[], host?: string): string[] {
  if (!host) {
    return args
  }
  let result = args
  if (result[0] === 'api' && !hasGhHostnameFlag(result)) {
    result = ['api', '--hostname', host, ...result.slice(1)]
  }
  // Why: bare OWNER/REPO shorthand resolves against gh's default host — GH_HOST
  // when set — so github.com must be qualified too, not just GHES, or a
  // process-level GH_HOST redirects pinned github.com commands.
  // Combined short forms (`-Ra/b`, `-R=a/b`) are deliberately not rewritten:
  // no call site uses them, and prefix-matching `-R` corrupts free-text values
  // of other flags (e.g. a --title that happens to start with `-R`).
  const qualified: string[] = []
  for (let i = 0; i < result.length; i += 1) {
    const arg = result[i]
    if (arg === '--repo' || arg === '-R') {
      qualified.push(arg)
      const value = result[i + 1]
      if (value !== undefined) {
        qualified.push(hostQualifiedGhRepoValue(value, host))
        i += 1
      }
      continue
    }
    if (arg.startsWith('--repo=')) {
      qualified.push(`--repo=${hostQualifiedGhRepoValue(arg.slice('--repo='.length), host)}`)
      continue
    }
    qualified.push(arg)
  }
  return qualified
}

function explicitGhHostname(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--hostname') {
      const value = args[i + 1]?.trim()
      return value || undefined
    }
    if (args[i].startsWith('--hostname=')) {
      const value = args[i].slice('--hostname='.length).trim()
      return value || undefined
    }
  }
  return undefined
}

function explicitGhRepoHostname(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    let value: string | undefined
    if (args[i] === '--repo' || args[i] === '-R') {
      value = args[i + 1]
    } else if (args[i].startsWith('--repo=')) {
      value = args[i].slice('--repo='.length)
    }
    const parts = value?.trim().split('/')
    if (parts?.length === 3 && parts.every(Boolean)) {
      return parts[0]
    }
  }
  return undefined
}

function ghRateLimitScope(
  args: readonly string[],
  options: GhExecOptions,
  resolved: ResolvedCommand
): string {
  const runtime = resolved.wsl ? `wsl:${resolved.wsl.distro.toLowerCase()}` : 'native'
  // Why: an explicit argv hostname controls the actual gh request even when
  // GH_HOST or options.host disagree, so breaker state must follow that host.
  const host =
    explicitGhHostname(args) ??
    options.host ??
    explicitGhRepoHostname(args) ??
    options.env?.GH_HOST ??
    process.env.GH_HOST ??
    'github.com'
  return ghRateLimitScopeKey(runtime, host)
}

function assertGhRateLimitScopeAvailable(
  args: readonly string[],
  options: GhExecOptions,
  resolved: ResolvedCommand,
  bucket: GhRateLimitBucket,
  exemptProbe: boolean
): void {
  if (exemptProbe) {
    return
  }
  const blockedUntilMs = getGhRateLimitBlockedUntilMs(
    bucket,
    Date.now(),
    ghRateLimitScope(args, options, resolved)
  )
  if (blockedUntilMs !== null) {
    throw createGhRateLimitBlockedError(bucket, blockedUntilMs)
  }
}

/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 *
 * Retries transient 5xx / 429-without-Retry-After / network-reset failures with
 * exponential backoff; other errors fail fast.
 */
export async function ghExecFileAsync(
  args: string[],
  options: GhExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // Why: retry safety must reflect the original call even when fallbacks replace the resolved command.
  const idempotent = options.idempotent ?? argsLookIdempotent(args)
  args = applyGhHostToArgs(args, options.host)
  let resolved = resolveCommand('gh', args, options.cwd, options.wslDistro)
  // Why: while a bucket is rate-limited every spawn returns 403 — fail fast; the probe is exempt so the breaker can learn the reset.
  // Why: scope by runtime and host so unrelated github.com, GHES, and WSL quotas cannot block each other.
  const rateLimitBucket = classifyGhRateLimitBucket(args)
  const rateLimitProbe = isGhRateLimitProbe(args)
  assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
  let lastError: unknown
  let attemptedHostFallback = false
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout, stderr } = await execFileCapture(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
        maxBuffer: options.maxBuffer,
        // Why: bound gh so one stuck child fails visibly instead of wedging the IPC lane.
        timeout: options.timeout ?? defaultGhExecTimeoutMs(options.env),
        env: nonInteractiveGhEnv(options.env)
      })
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      if (isGhPrimaryRateLimitStderr(stderr)) {
        notifyGhPrimaryRateLimit(rateLimitBucket, ghRateLimitScope(args, options, resolved))
      }
      if (
        process.platform === 'win32' &&
        !attemptedDefaultWslFallback &&
        resolved.wsl === null &&
        !options.cwd &&
        !options.wslDistro &&
        isHostCommandMissing(err, 'gh')
      ) {
        const wslResolved = resolveDefaultWslCli('gh', args)
        if (wslResolved) {
          // Why: WSL-only Windows installs have no host gh.exe, and global calls (rate_limit/auth) carry no cwd to route by.
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
          attempt = -1
          continue
        }
      }
      if (!attemptedHostFallback && canFallBackToHostGitHubCli('gh', args, resolved, stderr)) {
        resolved = resolveHostGitHubCli('gh', args)
        attemptedHostFallback = true
        assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
        attempt = -1
        continue
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        // Why: honor the server's Retry-After over our backoff (a shorter sleep just re-fails); cap so a huge hint can't stall IPC.
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs)
        continue
      }
      throw err
    }
  }
  // Unreachable: the loop either returns or throws. Here for TS exhaustiveness.
  throw lastError
}

// ─── glab CLI runner ────────────────────────────────────────────────
// Why: cloned from the gh runner rather than abstracted behind a generic runner, to avoid touching the working gh path.

type GlabExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  allowDefaultWslFallback?: boolean
}

/** Async glab CLI execution; drop-in for execFileAsync('glab', …). Retry policy mirrors ghExecFileAsync. */
/**
 * glab's `--hostname` rejects host:port, so a ported self-hosted GitLab must use the GITLAB_HOST env var instead — translate it.
 * @internal exported for tests.
 */
export function redirectPortedHostnameToEnv(
  args: string[],
  options: GlabExecOptions
): { args: string[]; options: GlabExecOptions } {
  const i = args.indexOf('--hostname')
  if (i === -1 || i + 1 >= args.length) {
    return { args, options }
  }
  const host = args[i + 1]
  if (!/^[^/\s]+:\d+$/.test(host)) {
    return { args, options }
  }
  return {
    args: [...args.slice(0, i), ...args.slice(i + 2)],
    options: { ...options, env: { ...(options.env ?? process.env), GITLAB_HOST: host } }
  }
}

export async function glabExecFileAsync(
  args: string[],
  options: GlabExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  ;({ args, options } = redirectPortedHostnameToEnv(args, options))
  let resolved = resolveCommand('glab', args, options.cwd, options.wslDistro)
  let lastError: unknown
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout, stderr } = await execFileCapture(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        env: options.env,
        signal: options.signal
      })
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      if (
        process.platform === 'win32' &&
        !attemptedDefaultWslFallback &&
        resolved.wsl === null &&
        !options.cwd &&
        !options.wslDistro &&
        options.allowDefaultWslFallback !== false &&
        isHostCommandMissing(err, 'glab')
      ) {
        const wslResolved = resolveDefaultWslCli('glab', args)
        if (wslResolved) {
          // Why: mirror gh's WSL-only fallback for global GitLab project/auth calls.
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          attempt = -1
          continue
        }
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      // Why: mirror gh's write-safety gate — don't auto-retry a non-idempotent write that GitLab may already have applied.
      const idempotent = options.idempotent ?? argsLookIdempotent(args)
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs)
        continue
      }
      throw err
    }
  }
  throw lastError
}

// ─── Generic command runner (for rg, etc.) ──────────────────────────

/**
 * Spawn any command with WSL awareness.
 * Used for non-git binaries like `rg` that also need WSL routing.
 */
export function wslAwareSpawn(
  command: string,
  args: string[],
  options: SpawnOptions & { cwd?: string; wslDistro?: string; useWslLoginShell?: boolean }
): ChildProcess {
  const { wslDistro, useWslLoginShell, ...spawnOptions } = options
  const resolved = resolveCommand(command, args, options.cwd, wslDistro, {
    useWslLoginShell
  })
  const spawnStartedAt = performance.now()
  const child = spawn(resolved.binary, resolved.args, {
    ...spawnOptions,
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}

// ─── Path translation helpers ───────────────────────────────────────

/**
 * Translate absolute Linux paths in git output back to Windows UNC paths.
 * Why: git-in-WSL emits Linux-native paths, but Orca reads files via Node fs, which needs Windows UNC.
 */
export function translateWslOutputPaths(
  output: string,
  originalCwd: string,
  options: { wslDistro?: string } = {}
): string {
  const wsl = parseWslPath(originalCwd)
  const distro = wsl?.distro ?? options.wslDistro
  if (!distro) {
    return output
  }

  // Rewrite absolute Linux paths in structured git output (e.g. "worktree /home/user/repo/feature") to Windows UNC.
  return output.replace(/(?<=worktree )(\/.+)$/gm, (_match, linuxPath: string) =>
    toWindowsWslPath(linuxPath, distro)
  )
}

/** Convenience re-export of wsl.ts path helpers so consumers don't import it directly. */
export { parseWslPath, toLinuxPath, toWindowsWslPath, isWslPath } from '../wsl'
