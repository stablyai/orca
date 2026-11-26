import path from 'node:path'
import {
  getExecutableNames,
  isQuotedWindowsPathEntry,
  stripWindowsPathQuotes
} from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  detectionDirectoryKey,
  directoryNameKey,
  isExecutableFile,
  scanDetectionDirectories
} from './command-path-directory'
import { readDetectionDirectoryViaWorker } from './command-path-directory-worker-client'
import {
  getWindowsPathSearchExtensions,
  isCommandOnLocalPath,
  joinCandidatePath,
  readEnvCaseInsensitive,
  type ResolveCommandOptions
} from './command-path-resolver'

/** Agent CLI fallback also checks a literal executable name without an extension. */
function getWindowsBatchDetectionExtensions(env: NodeJS.ProcessEnv, command: string): string[] {
  return [
    ...new Set([
      ...getWindowsPathSearchExtensions(env, command),
      ...getExecutableNames('win32', command).map((name) => name.slice(command.length))
    ])
  ]
}

const DIRECT_DETECTION_COMMAND_LIMIT = 4

export type AgentPathMatch = {
  user?: string
  first?: string
  unquoted?: string
}

type AgentPathInventory = {
  isRuntimePath: (entry: string) => boolean
  matches: Map<string, AgentPathMatch>
}

/** Bounded, lazy PATH detection; listings eliminate repeated probes for absence-heavy inventories. */
export async function findCommandsOnLocalPath(
  commands: readonly string[],
  options: ResolveCommandOptions & {
    matches?: Map<string, string>
    inventory?: AgentPathInventory
  } = {}
): Promise<Set<string>> {
  const found = new Set<string>()
  const remaining = new Set<string>()
  const isWin = (options.platform ?? process.platform) === 'win32'
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const env = options.env ?? process.env
  const inventory = options.inventory
  for (const command of commands.filter(Boolean)) {
    if (command.includes('/') || (isWin && command.includes('\\'))) {
      if (await isCommandOnLocalPath(command, options)) {
        found.add(command)
      }
    } else {
      remaining.add(command)
    }
  }
  const rawDirs = (readEnvCaseInsensitive(env, 'PATH') ?? '').split(isWin ? ';' : ':')
  if (isWin && !inventory) {
    rawDirs.unshift(options.cwd ?? process.cwd())
  }
  const seen = new Set<string>()
  const directories = rawDirs.flatMap((raw) => {
    const quoted = isWin && isQuotedWindowsPathEntry(raw)
    const dir = isWin ? stripWindowsPathQuotes(raw.trim()) : raw
    const key = detectionDirectoryKey(dir, isWin)
    const occurrence = inventory && quoted ? `${key}\0quoted` : key
    if (!isAbsolute(dir) || seen.has(occurrence)) {
      return []
    }
    seen.add(occurrence)
    return [{ dir, key, quoted, runtime: inventory?.isRuntimePath(dir) ?? false }]
  })
  const extensions = new Map(
    [...remaining].map((command) => [
      command,
      isWin
        ? inventory
          ? getWindowsPathSearchExtensions(env, command)
          : getWindowsBatchDetectionExtensions(env, command)
        : ['']
    ])
  )
  type Directory = (typeof directories)[number]
  const needsHit = (command: string, dir: Directory): boolean => {
    const hit = inventory?.matches.get(command)
    return !hit?.first || (!dir.quoted && !hit.unquoted) || (!dir.runtime && !hit.user)
  }
  // A quoted and unquoted occurrence may have different precedence, but share one physical read.
  const repeatedReads = new Map<string, Promise<[string, string][]>>()
  const scan = async (dir: Directory): Promise<[string, string][]> => {
    const needsReplay = inventory && seen.has(dir.key) && seen.has(`${dir.key}\0quoted`)
    const pending = repeatedReads.get(dir.key)
    if (pending) {
      repeatedReads.delete(dir.key)
      return pending
    }
    const read = async (): Promise<[string, string][]> => {
      const names =
        !isWin && remaining.size <= DIRECT_DETECTION_COMMAND_LIMIT
          ? null
          : await readDetectionDirectoryViaWorker(dir.dir)
      const hits = await Promise.all(
        [...remaining]
          .filter((command) => needsReplay || needsHit(command, dir))
          .map(async (command): Promise<[string, string] | undefined> => {
            const checked = new Set<string>()
            for (const ext of extensions.get(command) ?? []) {
              const wanted = command + ext
              const listed = names?.get(directoryNameKey(wanted))
              if (names !== null && listed === undefined) {
                continue
              }
              const candidate = joinCandidatePath(
                isWin,
                dir.dir,
                isWin ? (listed ?? wanted) : wanted
              )
              const key = isWin ? candidate.toLowerCase() : candidate
              if (checked.has(key) || !remaining.has(command)) {
                continue
              }
              checked.add(key)
              if (await isExecutableFile(candidate, isWin)) {
                return [command, candidate]
              }
            }
            return undefined
          })
      )
      return hits.filter((hit) => hit !== undefined)
    }
    const result = read()
    if (needsReplay) {
      repeatedReads.set(dir.key, result)
    }
    return result
  }
  const commit = (dir: Directory, hits: [string, string][]): void => {
    for (const [command, candidate] of hits) {
      if (!remaining.has(command)) {
        continue
      }
      if (inventory) {
        const match = inventory.matches.get(command) ?? {}
        match.first ??= candidate
        if (!dir.quoted) {
          match.unquoted ??= candidate
        }
        if (!dir.runtime) {
          match.user ??= candidate
        }
        inventory.matches.set(command, match)
        if (!match.user || !match.unquoted) {
          continue
        }
        options.matches?.set(command, match.user)
      } else {
        options.matches?.set(command, candidate)
      }
      remaining.delete(command)
      found.add(command)
    }
  }
  if (remaining.size) {
    await scanDetectionDirectories(
      directories,
      commands.length <= DIRECT_DETECTION_COMMAND_LIMIT ? 1 : 4,
      scan,
      commit,
      () => remaining.size === 0
    )
  }
  if (inventory) {
    for (const [command, match] of inventory.matches) {
      if (match.user) {
        found.add(command)
      }
    }
  }
  return found
}
