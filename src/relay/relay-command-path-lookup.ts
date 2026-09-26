import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import path, { win32 } from 'node:path'
import { buildRelayCommandEnv } from './relay-command-env'
import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'
import { SHELL_PATH_PROBE_ENV_VAR } from '../shared/shell-path-probe-env'

// Why: SSH exec channels give the relay a minimal environment without shell
// startup files sourced. Ask the user's configured shell so agent dirs added
// by zsh/bash/fish startup hooks match the remote terminal experience.
// Windows has no POSIX shell on native OpenSSH hosts, so use where.exe there.

const execFileAsync = promisify(execFile)

type CommandLookupSpec = {
  file: string
  args: string[]
  windowsHide?: true
}

export type RelayCommandLookupOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  accountLoginShell?: string | null
}

const SUPPORTED_POSIX_SHELLS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish'])
const CONSERVATIVE_SYSTEM_SHELL_DIRS = new Set(['/bin', '/usr/bin'])
const AGENT_PATH_PREFIX = '__ORCA_AGENT_PATH__'
const COMMAND_LOOKUP_TIMEOUT_MS = 5000
const BATCH_LOOKUP_COMMAND_VAR = '_orca_agent_cmd'

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
  return resolvePosixLookupShells(platform, env, accountLoginShell).map((shell) =>
    buildPosixCommandLookupSpec(command, shell)
  )
}

// Why: the trusted login shell sees PATH entries added by startup files; /bin/sh
// with the inherited PATH is the fallback when that shell is missing or fails.
function resolvePosixLookupShells(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  accountLoginShell?: string | null
): string[] {
  const trustedShell = pickTrustedPosixShell(
    env,
    resolveAccountLoginShell(platform, accountLoginShell)
  )
  const shells: string[] = []
  if (trustedShell) {
    shells.push(trustedShell)
  }
  if (trustedShell !== '/bin/sh') {
    shells.push('/bin/sh')
  }
  return shells
}

function buildCommandLookupEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  return { ...buildRelayCommandEnv(env, platform), [SHELL_PATH_PROBE_ENV_VAR]: '1' }
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
        env: buildCommandLookupEnv(env, platform),
        timeout: COMMAND_LOOKUP_TIMEOUT_MS,
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

/**
 * Resolve many commands with one shell per lookup stage instead of one shell per
 * command. Agent detection probes ~40 CLIs; running each in its own `-ilc` shell
 * sourced the user's rc files ~40 times in parallel for every new terminal.
 */
export async function resolveCommandPathsForRelay(
  commands: readonly string[],
  options: RelayCommandLookupOptions = {}
): Promise<Map<string, string | null>> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const uniqueCommands = [...new Set(commands.filter(Boolean))]
  const resolved = new Map<string, string | null>(uniqueCommands.map((cmd) => [cmd, null]))

  if (platform === 'win32') {
    // Why: where.exe loads no shell profile, so per-command lookups stay cheap.
    await Promise.all(
      uniqueCommands.map(async (cmd) => {
        resolved.set(cmd, await resolveCommandPathForRelay(cmd, options))
      })
    )
    return resolved
  }

  for (const shell of resolvePosixLookupShells(platform, env, options.accountLoginShell)) {
    const pending = uniqueCommands.filter((cmd) => resolved.get(cmd) === null)
    if (pending.length === 0) {
      break
    }
    try {
      const { stdout } = await execFileAsync(shell, buildPosixBatchLookupArgs(pending, shell), {
        encoding: 'utf-8',
        env: buildCommandLookupEnv(env, platform),
        timeout: COMMAND_LOOKUP_TIMEOUT_MS,
        windowsHide: true
      })
      for (const [cmd, executablePath] of parseBatchLookupOutput(stdout, pending)) {
        resolved.set(cmd, executablePath)
      }
    } catch {
      // Same contract as the single-command lookup: a failed stage falls through
      // to the next one, and commands it never resolved stay missing.
    }
  }

  return resolved
}

function buildPosixBatchLookupArgs(commands: readonly string[], shell: string): string[] {
  const commandList = commands.map(shellQuote).join(' ')
  if (path.posix.basename(shell).toLowerCase() === 'fish') {
    return [
      '-ilc',
      [
        `for ${BATCH_LOOKUP_COMMAND_VAR} in ${commandList}`,
        `set -l resolved (command -v $${BATCH_LOOKUP_COMMAND_VAR} 2>/dev/null)`,
        'if test -n "$resolved"',
        `printf '${AGENT_PATH_PREFIX}%s\\t%s\\n' $${BATCH_LOOKUP_COMMAND_VAR} "$resolved"`,
        'end',
        'end'
      ].join('\n')
    ]
  }
  return [
    getShellCommandMode(shell),
    [
      `for ${BATCH_LOOKUP_COMMAND_VAR} in ${commandList}; do`,
      buildPosixCommandPathLookupScript({ kind: 'shell-variable', name: BATCH_LOOKUP_COMMAND_VAR }),
      'if [ -n "$resolved" ]; then',
      `printf '${AGENT_PATH_PREFIX}%s\\t%s\\n' "$${BATCH_LOOKUP_COMMAND_VAR}" "$resolved"`,
      'fi',
      'done'
    ].join('\n')
  ]
}

function parseBatchLookupOutput(stdout: string, requested: readonly string[]): Map<string, string> {
  const requestedSet = new Set(requested)
  const found = new Map<string, string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(AGENT_PATH_PREFIX)) {
      continue
    }
    const payload = line.slice(AGENT_PATH_PREFIX.length)
    const separatorIndex = payload.indexOf('\t')
    if (separatorIndex <= 0) {
      continue
    }
    const cmd = payload.slice(0, separatorIndex)
    const executablePath = payload.slice(separatorIndex + 1)
    // Why: rc files can print banners; only accept sentinel lines for commands we
    // asked about, first hit wins, and the path must be absolute like the single lookup.
    if (requestedSet.has(cmd) && !found.has(cmd) && path.posix.isAbsolute(executablePath)) {
      found.set(cmd, executablePath)
    }
  }
  return found
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
