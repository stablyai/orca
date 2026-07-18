import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../shared/git-output-locale'
import { readValidGitConfigEnvCount } from '../../shared/git-credential-prompt-env'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { withGitSpan } from '../observability/instrumentation'
import { parseWslPath } from '../wsl'
import {
  commandExecFileAsync,
  extractExecError,
  gitExecFileAsync,
  nonInteractiveGitEnv
} from './runner'
import {
  buildWslStatusEnvironmentProbeCommand,
  invalidateWslStatusEnvironment,
  parseWslStatusEnvironmentProbe,
  resolveWslStatusEnvironment,
  type WslStatusEnvironment
} from './wsl-status-environment'

export type WslStatusGitOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
  signal?: AbortSignal
  timeout?: number
  wslDistro?: string
}

export type WslStatusTarget = {
  distro: string
  linuxCwd: string
}

const DEFAULT_WSL_SSH_COMMAND = 'ssh -o BatchMode=yes'
const WSL_STATUS_ENVIRONMENT_PROBE_TIMEOUT_MS = 15_000
const CACHED_GIT_UNAVAILABLE_MARKER = 'orca-wsl-status-cached-git-unavailable:'
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path'])

export function translateWslStatusArg(arg: string): string {
  const wslPath = parseWslPath(arg)
  if (wslPath) {
    return wslPath.linuxPath
  }
  const drivePath = arg.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!drivePath) {
    return arg
  }
  return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replace(/\\/g, '/')}`
}

export function resolveWslStatusTarget(options: WslStatusGitOptions): WslStatusTarget | null {
  if (process.platform !== 'win32') {
    return null
  }
  const cwdWsl = parseWslPath(options.cwd)
  const distro = cwdWsl?.distro ?? options.wslDistro
  if (!distro) {
    return null
  }
  return { distro, linuxCwd: cwdWsl?.linuxPath ?? translateWslStatusArg(options.cwd) }
}

export function wslStatusEnvironmentAssignments(
  spawnEnv: NodeJS.ProcessEnv,
  path?: string
): string[] {
  const assignments = [
    ...(path ? [`PATH=${path}`] : []),
    ...Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV).map(([key, value]) => `${key}=${value}`),
    'GIT_OPTIONAL_LOCKS=0',
    'GIT_TERMINAL_PROMPT=0',
    'GIT_ASKPASS=',
    'SSH_ASKPASS=',
    'GCM_INTERACTIVE=never'
  ]
  // Why: forward only Orca's Linux-safe default; a caller may have supplied a
  // Windows-specific ssh path which must not leak into the distro.
  if (spawnEnv.GIT_SSH_COMMAND === DEFAULT_WSL_SSH_COMMAND) {
    assignments.push(`GIT_SSH_COMMAND=${DEFAULT_WSL_SSH_COMMAND}`)
  }
  const configCount = readValidGitConfigEnvCount(spawnEnv)
  if (configCount === null) {
    return assignments
  }
  assignments.push(`GIT_CONFIG_COUNT=${configCount}`)
  for (let index = 0; index < configCount; index += 1) {
    assignments.push(`GIT_CONFIG_KEY_${index}=${spawnEnv[`GIT_CONFIG_KEY_${index}`]}`)
    assignments.push(`GIT_CONFIG_VALUE_${index}=${spawnEnv[`GIT_CONFIG_VALUE_${index}`]}`)
  }
  return assignments
}

async function probeWslStatusEnvironment(distro: string): Promise<WslStatusEnvironment | null> {
  // Why: this cache is distro-scoped; resolving from one repository would
  // leak its directory-specific PATH into every other worktree in the distro.
  const command = buildWslLoginShellCommand(buildWslStatusEnvironmentProbeCommand())
  const { stdout } = await commandExecFileAsync(
    'wsl.exe',
    ['-d', distro, '--', '/bin/sh', '-lc', escapeWslShCommandForWindows(command)],
    {
      env: nonInteractiveGitEnv(),
      maxBuffer: 256 * 1024,
      timeout: WSL_STATUS_ENVIRONMENT_PROBE_TIMEOUT_MS
    }
  )
  return parseWslStatusEnvironmentProbe(stdout)
}

export async function readWslStatusEnvironment(
  target: WslStatusTarget,
  signal?: AbortSignal
): Promise<WslStatusEnvironment | null> {
  return resolveWslStatusEnvironment(target.distro, probeWslStatusEnvironment, signal)
}

function gitDiagnosticShellName(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('-')) {
      return `orca:git ${arg.slice(0, 40)}`
    }
    if (GIT_VALUE_FLAGS.has(arg)) {
      index++
    }
  }
  return 'orca:git'
}

function buildShellGitCommand(
  target: WslStatusTarget,
  executable: string,
  args: string[],
  assignments: string[],
  verifyCachedExecutable: boolean
): string {
  const commandArgs = [executable, ...args.map(translateWslStatusArg)]
    .map(quotePosixShell)
    .join(' ')
  const command = verifyCachedExecutable
    ? `exec ${['/usr/bin/env', ...assignments].map(quotePosixShell).join(' ')} ${commandArgs}`
    : `${assignments.map(quoteShellEnvironmentAssignment).join(' ')} ${commandArgs}`
  const verification = verifyCachedExecutable ? `${cachedGitVerificationCommand(executable)}; ` : ''
  // Why: cd before invoking a cached mise/asdf shim; git -C changes Git's cwd
  // only after a version-manager shim has already selected its binary.
  return `cd ${quotePosixShell(target.linuxCwd)} || exit $?; ${verification}${command}`
}

function quoteShellEnvironmentAssignment(assignment: string): string {
  const separator = assignment.indexOf('=')
  const key = assignment.slice(0, separator)
  const value = assignment.slice(separator + 1)
  return `${key}=${quotePosixShell(value)}`
}

export function cachedGitVerificationCommand(executable: string): string {
  return `[ -x ${quotePosixShell(executable)} ] || { printf '%s%s\\n' ${quotePosixShell(CACHED_GIT_UNAVAILABLE_MARKER)} ${quotePosixShell(executable)} >&2; exit 127; }`
}

function shellWslArgs(target: WslStatusTarget, command: string, args: string[]): string[] {
  return [
    '-d',
    target.distro,
    '--',
    '/bin/sh',
    '-c',
    escapeWslShCommandForWindows(command),
    gitDiagnosticShellName(args)
  ]
}

export function directWslGitArgs(
  target: WslStatusTarget,
  environment: WslStatusEnvironment,
  args: string[],
  spawnEnv: NodeJS.ProcessEnv
): string[] {
  return shellWslArgs(
    target,
    buildShellGitCommand(
      target,
      environment.gitPath,
      args,
      wslStatusEnvironmentAssignments(spawnEnv, environment.path),
      true
    ),
    args
  )
}

export function loginShellWslGitArgs(
  target: WslStatusTarget,
  args: string[],
  spawnEnv: NodeJS.ProcessEnv
): string[] {
  const command = buildShellGitCommand(
    target,
    'git',
    args,
    wslStatusEnvironmentAssignments(spawnEnv),
    false
  )
  return [
    '-d',
    target.distro,
    '--',
    '/bin/sh',
    '-lc',
    escapeWslShCommandForWindows(buildWslLoginShellCommand(command)),
    gitDiagnosticShellName(args)
  ]
}

function errorExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'number') {
    return code
  }
  return typeof code === 'string' && /^\d+$/.test(code) ? Number(code) : null
}

export function isCachedGitUnavailable(error: unknown, gitPath: string): boolean {
  const code = errorExitCode(error)
  if (code !== 126 && code !== 127) {
    return false
  }
  const { stderr } = extractExecError(error)
  const detail = `${stderr}\n${error instanceof Error ? error.message : ''}`.toLowerCase()
  const normalizedPath = gitPath.toLowerCase()
  return (
    detail.includes(`${CACHED_GIT_UNAVAILABLE_MARKER}${normalizedPath}`) ||
    (detail.includes(normalizedPath) &&
      (detail.includes('no such file or directory') ||
        detail.includes('permission denied') ||
        detail.includes('not found') ||
        detail.includes('cannot execute')))
  )
}

export async function runWslStatusLoginShellGit(
  target: WslStatusTarget,
  args: string[],
  options: WslStatusGitOptions,
  spawnEnv: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return commandExecFileAsync('wsl.exe', loginShellWslGitArgs(target, args, spawnEnv), {
    env: spawnEnv,
    maxBuffer: options.maxBuffer,
    signal: options.signal,
    timeout: options.timeout
  })
}

export async function gitStatusExecFileAsync(
  args: string[],
  options: WslStatusGitOptions
): Promise<{ stdout: string; stderr: string }> {
  const target = resolveWslStatusTarget(options)
  if (!target) {
    return gitExecFileAsync(args, options)
  }
  return withGitSpan({ args, cwd: options.cwd }, async () => {
    const spawnEnv = nonInteractiveGitEnv(options.env)
    const environment = await readWslStatusEnvironment(target, options.signal)
    if (!environment) {
      return runWslStatusLoginShellGit(target, args, options, spawnEnv)
    }
    try {
      return await commandExecFileAsync(
        'wsl.exe',
        directWslGitArgs(target, environment, args, spawnEnv),
        {
          env: spawnEnv,
          maxBuffer: options.maxBuffer,
          signal: options.signal,
          timeout: options.timeout
        }
      )
    } catch (error) {
      if (options.signal?.aborted || !isCachedGitUnavailable(error, environment.gitPath)) {
        throw error
      }
      invalidateWslStatusEnvironment(target.distro, environment)
      return runWslStatusLoginShellGit(target, args, options, spawnEnv)
    }
  })
}
