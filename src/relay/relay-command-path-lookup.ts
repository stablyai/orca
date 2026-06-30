import { execFile } from 'child_process'
import { userInfo } from 'os'
import { promisify } from 'util'
import path, { win32 } from 'path'
import { buildRelayCommandEnv } from './relay-command-env'

const execFileAsync = promisify(execFile)

export type CommandLookupSpec = {
  file: string
  args: string[]
  windowsHide?: true
}

export type RelayCommandLookupOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  accountLoginShell?: string | null
  allowedShellNames?: readonly string[]
  includeInheritedPathFallback?: boolean
}

export type RelayCommandLaunch = {
  commandPath: string
  pathEnv?: string
}

const SUPPORTED_POSIX_SHELLS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish'])
const CONSERVATIVE_SYSTEM_SHELL_DIRS = new Set(['/bin', '/usr/bin'])
const AGENT_PATH_PREFIX = '__ORCA_AGENT_PATH__'
const AGENT_ENV_PATH_PREFIX = '__ORCA_AGENT_ENV_PATH__'
const commandLaunchCache = new Map<string, RelayCommandLaunch>()

export function _resetRelayCommandPathCacheForTests(): void {
  commandLaunchCache.clear()
}

function cacheKeyFor(args: {
  command: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  accountLoginShell: string | null
}): string {
  return JSON.stringify([
    args.command,
    args.platform,
    args.env.PATH ?? '',
    args.env.Path ?? '',
    args.env.SHELL ?? '',
    args.accountLoginShell ?? ''
  ])
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
  accountLoginShell?: string | null,
  options: Pick<
    RelayCommandLookupOptions,
    'allowedShellNames' | 'includeInheritedPathFallback'
  > = {}
): CommandLookupSpec[] {
  if (platform === 'win32') {
    return [{ file: 'where.exe', args: [command], windowsHide: true }]
  }
  const trustedShell = pickTrustedPosixShell(
    env,
    resolveAccountLoginShell(platform, accountLoginShell),
    options.allowedShellNames
  )
  const includeInheritedPathFallback = options.includeInheritedPathFallback !== false
  const specs: CommandLookupSpec[] = []

  if (trustedShell) {
    specs.push(buildPosixCommandLookupSpec(command, trustedShell))
  }

  if (includeInheritedPathFallback) {
    const inheritedPathSpec = buildPosixCommandLookupSpec(command, '/bin/sh')
    if (!trustedShell || trustedShell !== inheritedPathSpec.file) {
      specs.push(inheritedPathSpec)
    }
  }

  return specs
}

export async function resolveCommandLaunchForRelay(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<RelayCommandLaunch | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const accountLoginShell = resolveAccountLoginShell(platform, options.accountLoginShell)
  const allowedShellNames = options.allowedShellNames ?? [...SUPPORTED_POSIX_SHELLS]
  const cacheKey = cacheKeyFor({ command, platform, env, accountLoginShell })
  const cached = commandLaunchCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const specs = buildCommandLookupSpecs(command, platform, env, accountLoginShell, {
    allowedShellNames,
    includeInheritedPathFallback: options.includeInheritedPathFallback
  })

  for (const spec of specs) {
    try {
      const { stdout } = await execFileAsync(spec.file, spec.args, {
        encoding: 'utf-8',
        env: buildRelayCommandEnv(env, platform),
        timeout: 5000,
        ...(spec.windowsHide ? { windowsHide: true } : {})
      })
      const resolved = parseCommandLaunch(stdout, platform)
      if (resolved) {
        commandLaunchCache.set(cacheKey, resolved)
        return resolved
      }
    } catch {
      // Try the next trusted lookup source before reporting the agent missing.
    }
  }

  return null
}

export async function resolveCommandPathForRelay(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<string | null> {
  return (await resolveCommandLaunchForRelay(command, options))?.commandPath ?? null
}

export async function isCommandOnPathForRelay(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<boolean> {
  return (await resolveCommandLaunchForRelay(command, options)) !== null
}

export function hasAbsoluteCommandPath(output: string, platform: NodeJS.Platform): boolean {
  return parseCommandLaunch(output, platform) !== null
}

function parseCommandLaunch(output: string, platform: NodeJS.Platform): RelayCommandLaunch | null {
  const pathOps = platform === 'win32' ? win32 : path
  let commandPath: string | null = null
  let pathEnv: string | undefined

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (platform === 'win32') {
      if (pathOps.isAbsolute(trimmed)) {
        return { commandPath: trimmed }
      }
      continue
    }
    if (trimmed.startsWith(AGENT_PATH_PREFIX)) {
      const resolvedPath = trimmed.slice(AGENT_PATH_PREFIX.length)
      if (pathOps.isAbsolute(resolvedPath)) {
        commandPath = resolvedPath
      }
      continue
    }
    if (trimmed.startsWith(AGENT_ENV_PATH_PREFIX)) {
      pathEnv = trimmed.slice(AGENT_ENV_PATH_PREFIX.length)
    }
  }

  if (!commandPath) {
    return null
  }
  return pathEnv === undefined ? { commandPath } : { commandPath, pathEnv }
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
    `printf '${AGENT_ENV_PATH_PREFIX}%s\\n' "$PATH"`,
    'fi'
  ].join('\n')
}

function buildFishCommandLookupScript(command: string): string {
  const quotedCommand = shellQuote(command)
  return [
    `set -l resolved (command -v ${quotedCommand} 2>/dev/null)`,
    'if test -n "$resolved"',
    `printf '${AGENT_PATH_PREFIX}%s\\n' "$resolved"`,
    `printf '${AGENT_ENV_PATH_PREFIX}%s\\n' "$PATH"`,
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
  accountLoginShell: string | null,
  allowedShellNames: readonly string[] = [...SUPPORTED_POSIX_SHELLS]
): string | null {
  const shell = env.SHELL || accountLoginShell || ''
  if (!shell || !path.posix.isAbsolute(shell)) {
    return null
  }
  const shellName = path.posix.basename(shell).toLowerCase()
  if (!SUPPORTED_POSIX_SHELLS.has(shellName) || !allowedShellNames.includes(shellName)) {
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
