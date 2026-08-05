import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import path, { win32 } from 'node:path'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'
import { isPwshAvailable } from '../main/pwsh'
import { isWslAvailable, listWslDistros } from '../main/wsl'
import { isGitBashAvailable } from '../main/git-bash'
import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'
import {
  detectedAgentInventory,
  detectedAgentInventoryRequestSchema,
  emptyDetectedAgentInventory,
  type DetectedAgentInventoryRequestV1,
  type DetectedAgentInventoryV1
} from '../shared/detected-agent-inventory'

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

type AgentDetectionCommand = DetectedAgentInventoryRequestV1['commands'][number]

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
    this.dispatcher.onRequest('preflight.detectAgents', async (params) => {
      const inventory = await this.detectAgentInventory(params)
      return { agents: inventory.agents }
    })
    this.dispatcher.onRequest('preflight.detectAgentInventory', (params) =>
      this.detectAgentInventory(params)
    )
    this.dispatcher.onRequest('preflight.detectWindowsTerminalCapabilities', () =>
      this.detectWindowsTerminalCapabilities()
    )
  }

  // Why: the client sends the command list rather than importing TUI_AGENT_CONFIG
  // on the relay side. This keeps the relay bundle minimal and makes the protocol
  // self-describing — the relay doesn't need to know the agent catalog.
  private async detectAgentInventory(
    params: Record<string, unknown>
  ): Promise<DetectedAgentInventoryV1> {
    const parsed = detectedAgentInventoryRequestSchema.safeParse({
      ...params,
      version: params.version ?? 1
    })
    if (!parsed.success) {
      return emptyDetectedAgentInventory()
    }
    const commands = parsed.data.commands
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
        resolvedPath: await resolveCommandOnPathForRelay(cmd)
      }))
    )
    const foundCommands = new Set(
      results.filter((result) => result.resolvedPath).map(({ cmd }) => cmd)
    )
    await Promise.all(
      commands
        .filter((command) => command.capabilityProbe && foundCommands.has(command.cmd))
        .map(async (command) => {
          const resolvedPath = results.find((result) => result.cmd === command.cmd)?.resolvedPath
          if (!resolvedPath) {
            foundCommands.delete(command.cmd)
            return
          }
          try {
            await execFileAsync(resolvedPath, [...(command.capabilityProbe?.args ?? [])], {
              encoding: 'utf-8',
              env: buildRelayCommandEnv(process.env, process.platform),
              timeout: 5000,
              ...(process.platform === 'win32' ? { windowsHide: true } : {})
            })
          } catch {
            foundCommands.delete(command.cmd)
          }
        })
    )

    const agents = [
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
    const matchedCommands: Record<string, string> = {}
    for (const command of commands) {
      if (
        agents.includes(command.id) &&
        foundCommands.has(command.cmd) &&
        matchedCommands[command.id] === undefined
      ) {
        matchedCommands[command.id] = command.capabilityProbe?.matchedCommand ?? command.cmd
      }
    }
    return detectedAgentInventory(agents, matchedCommands)
  }

  private async detectWindowsTerminalCapabilities(): Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }> {
    const [wslAvailable, pwshAvailable, gitBashAvailable] = await Promise.all([
      Promise.resolve(isWslAvailable()).catch(() => false),
      Promise.resolve(isPwshAvailable()).catch(() => false),
      Promise.resolve(isGitBashAvailable()).catch(() => false)
    ])
    const wslDistros = wslAvailable ? await Promise.resolve(listWslDistros()).catch(() => []) : []
    return {
      wslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable,
      hostPlatform: process.platform
    }
  }
}

function isDetectionUnsupportedInRuntime(
  command: AgentDetectionCommand,
  runtime: NodeJS.Platform | 'wsl'
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
  return Boolean(await resolveCommandOnPathForRelay(command, options))
}

export async function resolveCommandOnPathForRelay(
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
      const resolvedPath = firstAbsoluteCommandPath(stdout, platform)
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
  return Boolean(firstAbsoluteCommandPath(output, platform))
}

function firstAbsoluteCommandPath(output: string, platform: NodeJS.Platform): string | null {
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
      .find((resolvedPath): resolvedPath is string => Boolean(resolvedPath)) ?? null
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
