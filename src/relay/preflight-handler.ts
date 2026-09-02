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
import {
  excludeMisidentifiedAgents,
  type SerializedIdentityExclusion
} from '../shared/tui-agent-identity-exclusion'

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
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly AgentDetectionRuntime[]
  identityExclusion?: SerializedIdentityExclusion
}

const IDENTITY_PROBE_TIMEOUT_MS = 5000

const SUPPORTED_POSIX_SHELLS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish'])
const CONSERVATIVE_SYSTEM_SHELL_DIRS = new Set(['/bin', '/usr/bin'])
const AGENT_PATH_PREFIX = '__ORCA_AGENT_PATH__'

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
  }

  // Why: the client sends the command list rather than importing TUI_AGENT_CONFIG
  // on the relay side. This keeps the relay bundle minimal and makes the protocol
  // self-describing — the relay doesn't need to know the agent catalog.
  private async detectAgents(params: Record<string, unknown>): Promise<{ agents: string[] }> {
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
        resolvedPath: await this.resolveCommandPath(cmd)
      }))
    )
    const foundPaths = new Map<string, string>()
    for (const { cmd, resolvedPath } of results) {
      if (resolvedPath) {
        foundPaths.set(cmd, resolvedPath)
      }
    }
    const foundCommands = new Set(foundPaths.keys())

    const detected = [
      ...new Set(
        commands
          .filter(
            (command) =>
              !isDetectionUnsupportedInRuntime(command, process.platform) &&
              foundCommands.has(command.cmd) &&
              (command.requiredCommands ?? []).every((required) => foundCommands.has(required))
          )
          .map(({ id }) => id)
      )
    ]
    // Why here too: a same-named unrelated tool on the SSH host would otherwise be
    // reported as the agent; the client cannot probe a remote binary itself.
    const agents = await excludeMisidentifiedAgents(
      commands,
      detected,
      foundCommands,
      (cmd, args) => runIdentityProbe(foundPaths.get(cmd), args)
    )
    return { agents }
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

  // Why: SSH exec channels give the relay a minimal environment without shell
  // startup files sourced. Ask the user's configured shell so agent dirs added
  // by zsh/bash/fish startup hooks match the remote terminal experience.
  // Windows has no POSIX shell on native OpenSSH hosts, so use where.exe there.
  private async resolveCommandPath(command: string): Promise<string | null> {
    return resolveCommandPathForRelay(command)
  }
}

async function runIdentityProbe(
  program: string | undefined,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  if (!program) {
    throw new Error('no resolved path to probe')
  }
  // Why runProcess: it starts Windows `.cmd` shims, which execFile cannot without a shell.
  const result = await runProcess({
    program,
    args,
    env: buildRelayCommandEnv(process.env, process.platform),
    timeoutMs: IDENTITY_PROBE_TIMEOUT_MS
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`${program} exited with ${result.code ?? result.signal ?? 'timeout'}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
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

/** Absolute path the lookup reported for `command`, or null when no probe found one. */
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
      const resolved = findAbsoluteCommandPath(stdout, platform)
      if (resolved) {
        return resolved
      }
    } catch {
      // Try the inherited-PATH fallback before reporting the agent missing.
    }
  }

  return null
}

export function hasAbsoluteCommandPath(output: string, platform: NodeJS.Platform): boolean {
  return findAbsoluteCommandPath(output, platform) !== null
}

function findAbsoluteCommandPath(output: string, platform: NodeJS.Platform): string | null {
  const pathOps = platform === 'win32' ? win32 : path
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const resolvedPath =
      platform === 'win32'
        ? line
        : line.startsWith(AGENT_PATH_PREFIX)
          ? line.slice(AGENT_PATH_PREFIX.length)
          : ''
    if (pathOps.isAbsolute(resolvedPath)) {
      return resolvedPath
    }
  }
  return null
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
