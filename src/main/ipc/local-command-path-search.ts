import { access, constants, stat } from 'node:fs/promises'
import path from 'node:path'

export type ResolveCommandOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Child directory for execution; preflight uses it only for Windows lookup. */
  cwd?: string
  maxResults?: number
}

export function readCommandEnvironment(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]
  if (direct !== undefined) {
    return direct
  }
  const lowerKey = key.toLowerCase()
  return Object.entries(env).find(([envKey]) => envKey.toLowerCase() === lowerKey)?.[1]
}

function windowsExtensions(env: NodeJS.ProcessEnv, command: string, execution: boolean) {
  if (execution && /\.(cmd|bat)$/i.test(command)) {
    return ['']
  }
  // Native spawn searches COM/EXE; batch files must already name their extension.
  const extensions = execution
    ? ['.com', '.exe']
    : (readCommandEnvironment(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  if (command.includes('.')) {
    extensions.unshift('')
  }
  return extensions
}

function childSearchPath(env: NodeJS.ProcessEnv, isWin: boolean): string {
  if (!isWin) {
    return env.PATH ?? '/usr/bin:/bin'
  }
  const key = Object.keys(env)
    .sort()
    .find((name) => name.toLowerCase() === 'path' && env[name] !== undefined)
  return (key ? env[key] : undefined) ?? readCommandEnvironment(process.env, 'PATH') ?? ''
}

function* commandCandidates(command: string, options: ResolveCommandOptions, execution: boolean) {
  const isWin = (options.platform ?? process.platform) === 'win32'
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const pathApi = isWin ? path.win32 : path.posix
  const hasSeparator = command.includes('/') || (isWin && command.includes('\\'))
  const pathValue = execution
    ? childSearchPath(env, isWin)
    : (readCommandEnvironment(env, 'PATH') ?? '')
  const pathDirs = pathValue
    .split(isWin ? ';' : ':')
    .filter((dir) => !execution || !isWin || dir.length > 0)
  const searchCwd =
    isWin &&
    (!execution ||
      readCommandEnvironment(process.env, 'NoDefaultCurrentDirectoryInExePath') === undefined)
  const directories = hasSeparator ? [''] : searchCwd ? [cwd, ...pathDirs] : pathDirs
  const extensions = isWin ? windowsExtensions(env, command, execution) : ['']
  const seen = new Set<string>()
  for (const dir of directories) {
    for (const ext of extensions) {
      const candidate = execution
        ? pathApi.resolve(cwd, dir, command) + ext
        : path.posix.join(dir, command) + ext
      const key = isWin ? candidate.toLowerCase() : candidate
      if (!pathApi.isAbsolute(candidate) || seen.has(key)) {
        continue
      }
      seen.add(key)
      yield candidate
    }
  }
}

async function inspectCandidate(
  candidate: string,
  isWin: boolean,
  direct: boolean
): Promise<'executable' | 'missing' | 'unknown'> {
  try {
    const stats = await stat(candidate)
    if (direct) {
      return 'executable'
    }
    if (stats.isDirectory() || (isWin && !stats.isFile())) {
      return 'unknown'
    }
    if (!isWin) {
      await access(candidate, constants.X_OK)
    }
    return 'executable'
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? 'missing'
      : 'unknown'
  }
}

export async function findLocalCommandPaths(
  command: string,
  options: ResolveCommandOptions,
  stopAtFirst: boolean
): Promise<string[]> {
  const found: string[] = []
  if (!command) {
    return found
  }
  const isWin = (options.platform ?? process.platform) === 'win32'
  for (const candidate of commandCandidates(command, options, false)) {
    if ((await inspectCandidate(candidate, isWin, false)) === 'executable') {
      found.push(candidate)
      if (stopAtFirst || found.length >= (options.maxResults ?? Infinity)) {
        break
      }
    }
  }
  return found
}

export type LocalExecutionCommand =
  | { status: 'resolved'; program: string }
  | { status: 'missing' | 'unknown' }

/** Resolve against the child directory without changing absolute-only preflight lookup. */
export async function resolveLocalExecutionCommand(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<LocalExecutionCommand> {
  const isWin = (options.platform ?? process.platform) === 'win32'
  if (!command || (isWin && /^[a-z]:(?![\\/])/i.test(command))) {
    return { status: 'unknown' }
  }
  try {
    if (!(await stat(options.cwd ?? process.cwd())).isDirectory()) {
      return { status: 'unknown' }
    }
  } catch {
    return { status: 'unknown' }
  }
  const direct = command.includes('/') || (isWin && command.includes('\\'))
  const searchPath = childSearchPath(options.env ?? process.env, isWin)
  if (
    isWin &&
    !direct &&
    (/["']/.test(searchPath) ||
      searchPath.split(';').some((entry) => /^[a-z]:(?![\\/])/i.test(entry)))
  ) {
    return { status: 'unknown' }
  }
  if (
    isWin &&
    !direct &&
    /\.(cmd|bat)$/i.test(command) &&
    readCommandEnvironment(process.env, 'NoDefaultCurrentDirectoryInExePath') !== undefined
  ) {
    return { status: 'unknown' }
  }
  for (const candidate of commandCandidates(command, options, true)) {
    const status = await inspectCandidate(candidate, isWin, direct)
    if (status === 'executable') {
      return { status: 'resolved', program: candidate }
    }
    if (status === 'unknown') {
      // An unreadable earlier entry may shadow every later candidate.
      return { status }
    }
  }
  return { status: 'missing' }
}
