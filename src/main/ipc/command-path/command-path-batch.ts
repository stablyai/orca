import { realpath } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import {
  getExecutableNames,
  isQuotedWindowsPathEntry,
  stripWindowsPathQuotes
} from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  detectionDirectoryKey,
  directoryNameKey,
  checkExecutableFile,
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
const FILESYSTEM_PROBE_TIMEOUT_MS = 1_000
const realpathNative = promisify(realpath.native)
const pendingFileProbes = new Map<string, ReturnType<typeof checkExecutableFile>>()

function probeExecutable(candidate: string, isWin: boolean) {
  const key = isWin ? `win32:${candidate.toLowerCase()}` : candidate
  let pending = pendingFileProbes.get(key)
  if (!pending) {
    // Reuse a timed-out probe until the underlying filesystem call settles.
    const probe = checkExecutableFile(candidate, isWin).finally(() => pendingFileProbes.delete(key))
    pending = withTimeout(probe, FILESYSTEM_PROBE_TIMEOUT_MS, 'unknown')
    pendingFileProbes.set(key, pending)
  }
  return pending
}

async function windowsHitSpelling(dir: string, candidate: string): Promise<string> {
  const basename = path.win32.basename(
    await withTimeout(realpathNative(candidate), FILESYSTEM_PROBE_TIMEOUT_MS, candidate)
  )
  // Native realpath can expand a short PATH directory name or follow a link.
  return basename.toLowerCase() === path.win32.basename(candidate).toLowerCase()
    ? joinCandidatePath(true, dir, basename)
    : candidate
}

export type AgentPathMatch = {
  user?: string
  // Null means an earlier candidate could not be verified, so a later hit must use its full path.
  first?: string | null
  unquoted?: string | null
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
    unverified?: Set<string>
  } = {}
): Promise<Set<string>> {
  const found = new Set<string>()
  const remaining = new Set<string>()
  const isWin = (options.platform ?? process.platform) === 'win32'
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const env = options.env ?? process.env
  const inventory = options.inventory
  const direct = new Set<string>()
  for (const command of commands.filter(Boolean)) {
    if (command.includes('/') || (isWin && command.includes('\\'))) {
      direct.add(command)
    } else {
      remaining.add(command)
    }
  }
  await Promise.all(
    [...direct].map(async (command) => {
      const executable = await isCommandOnLocalPath(command, {
        ...options,
        probeCandidate:
          options.probeCandidate ??
          (async (candidate) => {
            const result = await probeExecutable(candidate, isWin)
            if (result === 'unknown') {
              options.unverified?.add(command)
            }
            return result === 'executable'
          })
      })
      if (executable) {
        found.add(command)
      }
    })
  )
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
  type DirectoryProbe = { command: string; hit?: string; uncertain: boolean }
  const needsHit = (command: string, dir: Directory): boolean => {
    const hit = inventory?.matches.get(command)
    return (
      hit?.first === undefined ||
      (!dir.quoted && hit.unquoted === undefined) ||
      (!dir.runtime && !hit?.user)
    )
  }
  // A quoted and unquoted occurrence may have different precedence, but share one physical read.
  const repeatedReads = new Map<string, Promise<DirectoryProbe[]>>()
  const scan = async (dir: Directory): Promise<DirectoryProbe[]> => {
    const needsReplay = inventory && seen.has(dir.key) && seen.has(`${dir.key}\0quoted`)
    const pending = repeatedReads.get(dir.key)
    if (pending) {
      repeatedReads.delete(dir.key)
      return pending
    }
    const read = async (): Promise<DirectoryProbe[]> => {
      const names =
        !isWin && remaining.size <= DIRECT_DETECTION_COMMAND_LIMIT
          ? null
          : await readDetectionDirectoryViaWorker(dir.dir)
      const probes = await Promise.all(
        [...remaining]
          .filter((command) => needsReplay || needsHit(command, dir))
          .map(async (command): Promise<DirectoryProbe | undefined> => {
            const checked = new Set<string>()
            let uncertain = false
            for (const ext of extensions.get(command) ?? []) {
              const wanted = command + ext.toLowerCase()
              const key = directoryNameKey(wanted)
              const listed = names?.get(key)
              if (
                checked.has(key) ||
                !remaining.has(command) ||
                (names !== null && listed === undefined)
              ) {
                continue
              }
              checked.add(key)
              const candidate = joinCandidatePath(
                isWin,
                dir.dir,
                isWin ? (listed ?? wanted) : wanted
              )
              const outcome = await probeExecutable(candidate, isWin)
              if (outcome === 'executable') {
                const hit =
                  isWin && !listed && process.platform === 'win32'
                    ? await windowsHitSpelling(dir.dir, candidate)
                    : candidate
                return { command, hit, uncertain }
              }
              uncertain ||= outcome === 'unknown'
            }
            return uncertain ? { command, uncertain } : undefined
          })
      )
      return probes.filter((probe) => probe !== undefined)
    }
    const result = read()
    if (needsReplay) {
      repeatedReads.set(dir.key, result)
    }
    return result
  }
  const commit = (dir: Directory, probes: DirectoryProbe[]): void => {
    for (const { command, hit, uncertain } of probes) {
      if (!remaining.has(command)) {
        continue
      }
      if (uncertain) {
        options.unverified?.add(command)
      }
      if (inventory) {
        const match = inventory.matches.get(command) ?? {}
        const winner = uncertain ? null : hit
        if (match.first === undefined) {
          match.first = winner
        }
        if (!dir.quoted && match.unquoted === undefined) {
          match.unquoted = winner
        }
        if (!dir.runtime && hit) {
          match.user ??= hit
        }
        inventory.matches.set(command, match)
        if (!match.user || match.unquoted === undefined) {
          continue
        }
        options.matches?.set(command, match.user)
      } else if (hit) {
        options.matches?.set(command, hit)
      } else {
        continue
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
