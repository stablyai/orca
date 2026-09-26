import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import path, { win32 } from 'node:path'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'
import { isPwshAvailableAsync } from '../main/pwsh'
import { isWslAvailableAsync, listWslDistrosAsync } from '../main/wsl'
import { isGitBashAvailable } from '../main/git-bash'
import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'
import { runProcess } from '../shared/child-process/run-process'

const execFileAsync = promisify(execFile)

type CommandLookupSpec = {
  file: string
  args: string[]
  windowsHide?: true
}

type RelayCommandLookupOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  accountLoginShell?: string | null
}

type AgentDetectionRuntime = NodeJS.Platform | 'wsl'

type AgentDetectionCommand = {
  id: string
  cmd: string
  reportVersion?: true
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly AgentDetectionRuntime[]
}

const SUPPORTED_POSIX_SHELLS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish'])
const CONSERVATIVE_SYSTEM_SHELL_DIRS = new Set(['/bin', '/usr/bin'])
const AGENT_PATH_PREFIX = '__ORCA_AGENT_PATH__'

const FORGE_CLI_ALLOWLIST = new Set(['gh', 'glab'])
// Why: the caller abandons at 8s (REMOTE_FORGE_PROBE_TIMEOUT_MS in
// src/main/ipc/preflight.ts), and a forge probe pays lookup then auth, so the
// auth budget must stay well under it.
const FORGE_AUTH_TIMEOUT_MS = 5_000

export class PreflightHandler {
  private dispatcher: RelayDispatcher

  constructor(dispatcher: RelayDispatcher) {
    this.dispatcher = dispatcher
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('preflight.detectAgents', (p) => this.detectAgents(p))
    this.dispatcher.onRequest('preflight.detectWindowsTerminalCapabilities', () =>
      this.detectWindowsTerminalCapabilities()
    )
    this.dispatcher.onRequest('preflight.detectForgeClis', (p) => this.detectForgeClis(p))
  }

  // Why: the client sends the command list rather than importing TUI_AGENT_CONFIG
  // on the relay side. This keeps the relay bundle minimal and makes the protocol
  // self-describing — the relay doesn't need to know the agent catalog.
  private async detectAgents(params: Record<string, unknown>): Promise<{
    agents: string[]
    versions?: Record<string, string>
  }> {
    const commands = params.commands as AgentDetectionCommand[]
    if (!Array.isArray(commands)) {
      return { agents: [] }
    }
    const probeCommands = [
      ...new Set(
        commands
          .filter((command) => !isDetectionUnsupportedInRuntime(command, process.platform))
          .flatMap((command) => [command.cmd, ...(command.requiredCommands ?? [])])
      )
    ]

    const results = await Promise.all(
      probeCommands.map(async (cmd) => ({
        cmd,
        executablePath: await resolveCommandPathForRelay(cmd)
      }))
    )
    const foundCommands = new Set(
      results.filter((result) => result.executablePath !== null).map(({ cmd }) => cmd)
    )
    const detectedCommands = commands.filter(
      (command) =>
        !isDetectionUnsupportedInRuntime(command, process.platform) &&
        foundCommands.has(command.cmd) &&
        (command.requiredCommands ?? []).every((required) => foundCommands.has(required))
    )
    const versions: Record<string, string> = {}
    for (const command of detectedCommands) {
      if (
        command.id !== 'claude' ||
        command.reportVersion !== true ||
        versions.claude !== undefined
      ) {
        continue
      }
      const executablePath = results.find((result) => result.cmd === command.cmd)?.executablePath
      if (!executablePath) {
        continue
      }
      const version = await probeCommandVersion(executablePath)
      if (version) {
        versions[command.id] = version
      }
    }

    return {
      agents: [...new Set(detectedCommands.map(({ id }) => id))],
      ...(Object.keys(versions).length > 0 ? { versions } : {})
    }
  }

  private async detectWindowsTerminalCapabilities(): Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }> {
    const [wslAvailable, pwshAvailable, gitBashAvailable] = await Promise.all([
      isWslAvailableAsync().catch(() => false),
      isPwshAvailableAsync().catch(() => false),
      Promise.resolve(isGitBashAvailable()).catch(() => false)
    ])
    const wslDistros = wslAvailable ? await listWslDistrosAsync().catch(() => []) : []
    return {
      wslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable,
      hostPlatform: process.platform
    }
  }

  private async resolveCommandPath(command: string): Promise<string | null> {
    return resolveCommandPathForRelay(command)
  }

  // Why: ignore rather than error on non-allowlisted entries — a newer desktop
  // probing a CLI this relay doesn't know must degrade, mirroring how missing
  // methods degrade.
  private async detectForgeClis(
    params: Record<string, unknown>
  ): Promise<{ results: Record<string, { installed: boolean; authenticated: boolean }> }> {
    // Why: iterate the allowlist, not the request — duplicated names would
    // otherwise spawn one probe per repetition.
    const requested = new Set(Array.isArray(params.clis) ? (params.clis as string[]) : [])
    const clis = [...FORGE_CLI_ALLOWLIST].filter((cli) => requested.has(cli))
    const results: Record<string, { installed: boolean; authenticated: boolean }> = {}
    await Promise.all(
      clis.map(async (cli) => {
        // Why: detection resolves through a login shell, so a PATH set in a
        // shell startup file is visible here but not to a bare execFile. Reuse
        // the resolved executable so "installed" and "authenticated" can never
        // disagree about which binary they mean.
        const executable = await this.resolveCommandPath(cli)
        results[cli] = {
          installed: executable !== null,
          authenticated:
            executable !== null && (await isForgeCliAuthenticated(cli as 'gh' | 'glab', executable))
        }
      })
    )
    return { results }
  }

  // Why: SSH exec channels give the relay a minimal environment without shell
  // startup files sourced. Ask the user's configured shell so agent dirs added
  // by zsh/bash/fish startup hooks match the remote terminal experience.
  // Windows has no POSIX shell on native OpenSSH hosts, so use where.exe there.
}

async function probeCommandVersion(executablePath: string): Promise<string | null> {
  try {
    const env = buildRelayCommandEnv(process.env, process.platform)
    const pathKey = process.platform === 'win32' && env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: ['--version'],
      env: {
        ...env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
    if (result.code !== 0) {
      return null
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

// Why: glab writes auth status to stderr in some versions and can exit
// non-zero while still logged in, so check output markers on failure too.
// Markers mirror the main-process per-CLI checks (isGhAuthenticated /
// isGlabAuthenticated in src/main/ipc/preflight.ts).
async function isForgeCliAuthenticated(cli: 'gh' | 'glab', executable: string): Promise<boolean> {
  try {
    await execFileAsync(executable, ['auth', 'status'], {
      encoding: 'utf-8',
      env: buildRelayCommandEnv(),
      timeout: FORGE_AUTH_TIMEOUT_MS,
      windowsHide: true
    })
    return true
  } catch (error) {
    // Why: killed or timed-out probes keep partial output, so a hung `auth status`
    // that already printed a marker must read as unknown, never a yes.
    const failure = error as {
      stdout?: string
      stderr?: string
      killed?: boolean
      signal?: string
      code?: string
    }
    if (failure.killed === true || failure.signal != null || failure.code === 'ETIMEDOUT') {
      return false
    }
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    return cli === 'gh'
      ? output.includes('Logged in') || output.includes('Active account: true')
      : output.includes('Logged in')
  }
}

function isDetectionUnsupportedInRuntime(
  command: AgentDetectionCommand,
  runtime: AgentDetectionRuntime
): boolean {
  return command.unsupportedRuntimes?.includes(runtime) === true
}

export function buildCommandLookupSpec(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  accountLoginShell?: string | null
): CommandLookupSpec {
  const [spec] = buildCommandLookupSpecs(command, platform, env, accountLoginShell)
  return spec ?? buildPosixCommandLookupSpec(command, '/bin/sh')
}

export function buildCommandLookupSpecs(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  accountLoginShell?: string | null
): CommandLookupSpec[] {
  if (platform === 'win32') {
    return [{ file: 'where.exe', args: [command], windowsHide: true }]
  }
  const trustedShell = pickTrustedPosixShell(
    env,
    resolveAccountLoginShell(platform, accountLoginShell)
  )
  const specs: CommandLookupSpec[] = []

  if (trustedShell) {
    specs.push(buildPosixCommandLookupSpec(command, trustedShell))
  }

  const inheritedPathSpec = buildPosixCommandLookupSpec(command, '/bin/sh')
  if (!trustedShell || trustedShell !== inheritedPathSpec.file) {
    specs.push(inheritedPathSpec)
  }

  return specs
}

export async function isCommandOnPathForRelay(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<boolean> {
  return (await resolveCommandPathForRelay(command, options)) !== null
}

export async function resolveCommandPathForRelay(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const specs = buildCommandLookupSpecs(command, platform, env, options.accountLoginShell)

  for (const spec of specs) {
    try {
      const { stdout } = await execFileAsync(spec.file, spec.args, {
        encoding: 'utf-8',
        env: buildRelayCommandEnv(env, platform),
        timeout: 5000,
        ...(spec.windowsHide ? { windowsHide: true } : {})
      })
      const resolvedPath = getAbsoluteCommandPath(stdout, platform)
      if (resolvedPath) {
        return resolvedPath
      }
    } catch {
      // Try the inherited-PATH fallback before reporting the agent missing.
    }
  }

  return null
}

export function hasAbsoluteCommandPath(output: string, platform: NodeJS.Platform): boolean {
  return getAbsoluteCommandPath(output, platform) !== null
}

function getAbsoluteCommandPath(output: string, platform: NodeJS.Platform): string | null {
  const pathOps = platform === 'win32' ? win32 : path
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => {
        const resolvedPath =
          platform === 'win32'
            ? line
            : line.startsWith(AGENT_PATH_PREFIX)
              ? line.slice(AGENT_PATH_PREFIX.length)
              : ''
        return pathOps.isAbsolute(resolvedPath) ? resolvedPath : null
      })
      .find((resolvedPath): resolvedPath is string => resolvedPath !== null) ?? null
  )
}

function buildPosixCommandLookupSpec(command: string, shell: string): CommandLookupSpec {
  const shellName = path.posix.basename(shell).toLowerCase()
  if (shellName === 'fish') {
    return { file: shell, args: ['-ilc', buildFishCommandLookupScript(command)] }
  }
  return { file: shell, args: [getShellCommandMode(shell), buildShCommandLookupScript(command)] }
}

function buildShCommandLookupScript(command: string): string {
  // Why: login shells may define aliases or functions that mask the PATH executable.
  return [
    buildPosixCommandPathLookupScript({ kind: 'literal', value: command }),
    'if [ -n "$resolved" ]; then',
    `printf '${AGENT_PATH_PREFIX}%s\\n' "$resolved"`,
    'fi'
  ].join('\n')
}

function buildFishCommandLookupScript(command: string): string {
  const quotedCommand = shellQuote(command)
  return [
    `set -l resolved (command -v ${quotedCommand} 2>/dev/null)`,
    'if test -n "$resolved"',
    `printf '${AGENT_PATH_PREFIX}%s\\n' "$resolved"`,
    'end'
  ].join('\n')
}

function resolveAccountLoginShell(
  platform: NodeJS.Platform,
  accountLoginShell?: string | null
): string | null {
  if (accountLoginShell !== undefined) {
    return accountLoginShell
  }
  if (platform === 'win32') {
    return null
  }
  try {
    return userInfo().shell ?? null
  } catch {
    return null
  }
}

function pickTrustedPosixShell(
  env: NodeJS.ProcessEnv,
  accountLoginShell: string | null
): string | null {
  const shell = env.SHELL
  if (!shell || !path.posix.isAbsolute(shell)) {
    return null
  }
  const shellName = path.posix.basename(shell).toLowerCase()
  if (!SUPPORTED_POSIX_SHELLS.has(shellName)) {
    return null
  }
  if (accountLoginShell) {
    return shell === accountLoginShell ? shell : null
  }
  return CONSERVATIVE_SYSTEM_SHELL_DIRS.has(path.posix.dirname(shell)) ? shell : null
}

function getShellCommandMode(shell: string): '-lc' | '-ilc' {
  const shellName = path.posix.basename(shell).toLowerCase()
  // Why: bash/zsh/fish users commonly add package-manager bins from interactive
  // startup files. POSIX sh/dash may not support interactive login flags.
  return shellName === 'sh' || shellName === 'dash' ? '-lc' : '-ilc'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
