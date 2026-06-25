import { execFile } from 'child_process'
import { userInfo } from 'os'
import { promisify } from 'util'
import path, { win32 } from 'path'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'

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
  }

  // Why: the client sends the command list rather than importing TUI_AGENT_CONFIG
  // on the relay side. This keeps the relay bundle minimal and makes the protocol
  // self-describing — the relay doesn't need to know the agent catalog.
  private async detectAgents(params: Record<string, unknown>): Promise<{ agents: string[] }> {
    const commands = params.commands as { id: string; cmd: string }[]
    if (!Array.isArray(commands)) {
      return { agents: [] }
    }

    const results = await Promise.all(
      commands.map(async ({ id, cmd }) => ({
        id,
        installed: await this.isCommandOnPath(cmd)
      }))
    )

    return { agents: [...new Set(results.filter((r) => r.installed).map((r) => r.id))] }
  }

  // Why: SSH exec channels give the relay a minimal environment without shell
  // startup files sourced. Ask the user's configured shell so agent dirs added
  // by zsh/bash/fish startup hooks match the remote terminal experience.
  // Windows has no POSIX shell on native OpenSSH hosts, so use where.exe there.
  private async isCommandOnPath(command: string): Promise<boolean> {
    return isCommandOnPathForRelay(command)
  }
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
      if (hasAbsoluteCommandPath(stdout, platform)) {
        return true
      }
    } catch {
      // Try the inherited-PATH fallback before reporting the agent missing.
    }
  }

  return false
}

export function hasAbsoluteCommandPath(output: string, platform: NodeJS.Platform): boolean {
  const pathOps = platform === 'win32' ? win32 : path
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => {
      const resolvedPath =
        platform === 'win32'
          ? line
          : line.startsWith(AGENT_PATH_PREFIX)
            ? line.slice(AGENT_PATH_PREFIX.length)
            : ''
      return pathOps.isAbsolute(resolvedPath)
    })
}

function buildPosixCommandLookupSpec(command: string, shell: string): CommandLookupSpec {
  const shellName = path.posix.basename(shell).toLowerCase()
  if (shellName === 'fish') {
    return { file: shell, args: ['-ilc', buildFishCommandLookupScript(command)] }
  }
  return { file: shell, args: [getShellCommandMode(shell), buildShCommandLookupScript(command)] }
}

function buildShCommandLookupScript(command: string): string {
  const quotedCommand = shellQuote(command)
  return [
    `if resolved=$(command -v ${quotedCommand} 2>/dev/null); then`,
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
