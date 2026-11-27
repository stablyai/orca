import { statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'
import { stripWindowsPathQuotes } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import { isExecutableFile } from './command-path-directory'

export type ResolveCommandOptions = {
  /** Defaults to `process.platform`. Lets tests exercise the win32 lookup on posix. */
  platform?: NodeJS.Platform
  /** Env whose PATH/PATHEXT to search. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** CWD used only for the win32 "search current directory first" rule. */
  cwd?: string
  /** Search exactly these already resolved PATH entries. */
  pathEntries?: readonly string[]
  /** Stop after this many matches; defaults to the complete list. */
  maxResults?: number
  signal?: AbortSignal
  /** Override the file probe while preserving candidate order and cancellation. */
  probeCandidate?: (candidate: string) => Promise<boolean>
}

// Windows environment keys are case-insensitive even though this Record is not.
export function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]
  if (direct !== undefined) {
    return direct
  }
  const lowerKey = key.toLowerCase()
  for (const [envKey, value] of Object.entries(env)) {
    if (envKey.toLowerCase() === lowerKey) {
      return value
    }
  }
  return undefined
}

export function getWindowsPathSearchExtensions(env: NodeJS.ProcessEnv, command: string): string[] {
  const pathext = readEnvCaseInsensitive(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM'
  const extensions = pathext.split(';').filter((ext) => ext.length > 0)
  // Like libuv, only a dot in the basename permits an exact-name match, so a dotted parent
  // (`node_modules\.bin\prettier`) cannot select the extensionless POSIX shim.
  if (path.win32.basename(command).includes('.')) {
    extensions.unshift('')
  }
  return extensions
}

type LocalCommandSelection = {
  scope: string
  selected?: { binary: string; stamp: string; cwd?: string }
}

const localCommandSelections = new Map<string, LocalCommandSelection>()

function selectionScope(options: ResolveCommandOptions): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const isWin = platform === 'win32'
  const pathValue = readEnvCaseInsensitive(env, 'PATH') ?? ''
  const pathApi = isWin ? path.win32 : path.posix
  const needsCwd = pathValue
    .split(isWin ? ';' : ':')
    .some((dir) => !pathApi.isAbsolute(isWin ? stripWindowsPathQuotes(dir) : dir))
  return JSON.stringify([
    platform,
    pathValue,
    isWin ? readEnvCaseInsensitive(env, 'PATHEXT') : null,
    env.HOME,
    env.USERPROFILE,
    homedir(),
    needsCwd ? (options.cwd ?? process.cwd()) : null
  ])
}

function commandFileStamp(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode].join(':')
}

/** Publish only a successful version probe; a newer probe supersedes an older one. */
export function beginLocalCommandSelection(
  command: string
): (binary: string | null) => Promise<void> {
  if (command !== 'gh' && command !== 'glab') {
    return async () => {}
  }
  const scope = selectionScope({})
  const probeCwd = process.cwd()
  const previous = localCommandSelections.get(command)
  const selection: LocalCommandSelection = {
    scope,
    selected: previous?.scope === scope ? previous.selected : undefined
  }
  localCommandSelections.set(command, selection)
  return async (binary) => {
    if (localCommandSelections.get(command) !== selection) {
      return
    }
    if (binary === null || !path.isAbsolute(binary)) {
      delete selection.selected
      return
    }
    try {
      const stats = await stat(binary)
      if (localCommandSelections.get(command) === selection) {
        const cwd =
          process.platform === 'win32' &&
          path.win32.resolve(path.win32.dirname(binary)).toLowerCase() ===
            path.win32.resolve(probeCwd).toLowerCase()
            ? probeCwd
            : undefined
        // Only a current-directory CLI needs to stay tied to the probe's folder.
        selection.selected = stats.isFile()
          ? { binary, stamp: commandFileStamp(stats), cwd }
          : undefined
      }
    } catch {
      // A binary removed during the probe must not become the runtime selection.
      if (localCommandSelections.get(command) === selection) {
        delete selection.selected
      }
    }
  }
}

/** Whether a probe selected a binary for this command; no filesystem check. */
export function hasLocalCommandSelection(command: string): boolean {
  return localCommandSelections.get(command)?.selected !== undefined
}

/** Native execution reuses preflight's selection without probing or replaying the operation. */
export function resolveSelectedLocalCommand(
  command: string,
  options: ResolveCommandOptions = {}
): string {
  const selection = localCommandSelections.get(command)
  if (!selection?.selected || selection.scope !== selectionScope(options)) {
    return command
  }
  if (
    selection.selected.cwd &&
    path.win32.resolve(options.cwd ?? process.cwd()).toLowerCase() !==
      path.win32.resolve(selection.selected.cwd).toLowerCase()
  ) {
    return command
  }
  try {
    const stats = statSync(selection.selected.binary)
    if (commandFileStamp(stats) === selection.selected.stamp) {
      return selection.selected.binary
    }
  } catch {
    // Missing or replaced binaries require a fresh version probe.
  }
  delete selection.selected
  return command
}

/** Filesystem-only PATH lookup preserving the preflight absolute-path filter; use listLocalCommandPaths for shadowed candidates. */
export async function isCommandOnLocalPath(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<boolean> {
  return (await findLocalCommandPaths(command, options, true)).length > 0
}

// Real Windows hosts get native separators (and keep UNC roots);
// synthetic win32 lookups on POSIX hosts keep POSIX joins.
export const joinCandidatePath = (isWin: boolean, dir: string, name: string): string =>
  (isWin ? path.join : path.posix.join)(dir, name)

/** The absolute path `isCommandOnLocalPath` found, or null. */
export async function resolveCommandOnLocalPath(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<string | null> {
  return (await findLocalCommandPaths(command, options, true))[0] ?? null
}

/** Ordered, deduplicated candidates, including executable shims that may fail to run. */
export async function listLocalCommandPaths(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<string[]> {
  return findLocalCommandPaths(command, options, false)
}

async function findLocalCommandPaths(
  command: string,
  options: ResolveCommandOptions,
  stopAtFirst: boolean
): Promise<string[]> {
  if (!command) {
    return []
  }
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const isWin = platform === 'win32'
  // Use the requested platform's absolute-path rules, not the test host's.
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const hasPathSeparator = command.includes('/') || (isWin && command.includes('\\'))
  const rawPathDirs = (readEnvCaseInsensitive(env, 'PATH') ?? '').split(isWin ? ';' : ':')
  const pathDirs = isWin ? rawPathDirs.map(stripWindowsPathQuotes) : rawPathDirs
  // Separators bypass PATH; Windows searches cwd first.
  const searchDirs = hasPathSeparator
    ? ['']
    : (options.pathEntries ?? (isWin ? [cwd, ...pathDirs] : pathDirs))
  const extensions = isWin ? getWindowsPathSearchExtensions(env, command) : ['']

  const found: string[] = []
  const seen = new Set<string>()
  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const candidate = joinCandidatePath(isWin, dir, command) + ext
      // Preserve the prior where/which absolute-resolution filter.
      const candidateKey = isWin ? candidate.toLowerCase() : candidate
      if (!isAbsolute(candidate) || seen.has(candidateKey)) {
        continue
      }
      seen.add(candidateKey)
      throwIfSignalAborted(options.signal)
      if (await (options.probeCandidate?.(candidate) ?? isExecutableFile(candidate, isWin))) {
        found.push(candidate)
        if (stopAtFirst || found.length >= (options.maxResults ?? Infinity)) {
          return found
        }
      }
    }
  }
  return found
}
