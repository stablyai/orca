import { realpath } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  UNVERIFIED_FS_PROBE,
  type InventoryFsProbes
} from '../../../shared/shell/command-resolution/inventory-fs-probes'
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
import {
  recordDirectoryMatch,
  scanInventoryPathCommands,
  type AgentPathMatch,
  type DirectoryCandidate,
  type PathDirectory
} from './command-path-inventory-scan'
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
const realpathNative = promisify(realpath.native)

async function windowsHitSpelling(
  dir: string,
  candidate: string,
  probes?: InventoryFsProbes
): Promise<string> {
  const resolved = await (probes
    ? probes.read(candidate, 'realpath', () => realpathNative(candidate))
    : realpathNative(candidate).catch(() => null))
  const basename = path.win32.basename(typeof resolved === 'string' ? resolved : candidate)
  // Native realpath can expand a short PATH directory name or follow a link.
  return basename.toLowerCase() === path.win32.basename(candidate).toLowerCase()
    ? joinCandidatePath(true, dir, basename)
    : candidate
}

export type { AgentPathMatch } from './command-path-inventory-scan'

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
    found?: Set<string>
    probes?: InventoryFsProbes
    inventoryScan?: { partialBudget: Promise<unknown>; commandCount: number }
    onMatch?: () => void
    onCommandComplete?: (command: string, uncertain: boolean) => void
  } = {}
): Promise<Set<string>> {
  const found = options.found ?? new Set<string>()
  const remaining = new Set<string>()
  const isWin = (options.platform ?? process.platform) === 'win32'
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const env = options.env ?? process.env
  const inventory = options.inventory
  const probes = options.probes
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
      let uncertain = false
      const executable = await isCommandOnLocalPath(command, {
        ...options,
        probeCandidate:
          options.probeCandidate ??
          (async (candidate) => {
            const result = await checkExecutableFile(candidate, isWin, probes)
            if (result === 'unknown') {
              uncertain = true
              options.unverified?.add(command)
            }
            return result === 'executable'
          })
      })
      if (executable) {
        found.add(command)
      }
      options.onCommandComplete?.(command, uncertain)
    })
  )
  if (remaining.size === 0) {
    return found
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
  type DirectoryProbe = DirectoryCandidate & { command: string }
  const needsHit = (command: string, dir: PathDirectory): boolean => {
    const hit = inventory?.matches.get(command)
    return (
      hit?.first === undefined ||
      (!dir.quoted && hit.unquoted === undefined) ||
      (!dir.runtime && !hit?.user)
    )
  }
  type Listing = Map<string, string> | null | typeof UNVERIFIED_FS_PROBE
  const readListing = async (dir: PathDirectory): Promise<Listing> => {
    if (!isWin && remaining.size <= DIRECT_DETECTION_COMMAND_LIMIT) {
      return null
    }
    const read = async (): Promise<Listing> => {
      const names = await readDetectionDirectoryViaWorker(dir.dir, probes !== undefined)
      return names === 'unverified' ? UNVERIFIED_FS_PROBE : names
    }
    return probes ? probes.read(dir.dir, 'listing', read) : read()
  }
  const probeCommand = async (
    command: string,
    dir: PathDirectory,
    listing: Listing
  ): Promise<DirectoryCandidate> => {
    const names = listing === UNVERIFIED_FS_PROBE ? null : listing
    const checked = new Set<string>()
    let uncertain = listing === UNVERIFIED_FS_PROBE
    for (const ext of extensions.get(command) ?? []) {
      const wanted = command + ext.toLowerCase()
      const key = directoryNameKey(wanted)
      const listed = names?.get(key)
      if (checked.has(key) || !remaining.has(command) || (names !== null && listed === undefined)) {
        continue
      }
      checked.add(key)
      const candidate = joinCandidatePath(isWin, dir.dir, isWin ? (listed ?? wanted) : wanted)
      const outcome = await checkExecutableFile(candidate, isWin, probes)
      if (outcome === 'executable') {
        const hit =
          isWin && !listed && process.platform === 'win32'
            ? await windowsHitSpelling(dir.dir, candidate, probes)
            : candidate
        return { hit, uncertain }
      }
      uncertain ||= outcome === 'unknown'
    }
    return { uncertain }
  }
  const { inventoryScan, signal } = options
  const concurrency =
    (inventoryScan?.commandCount ?? commands.length) <= DIRECT_DETECTION_COMMAND_LIMIT ? 1 : 4
  if (inventory && probes && signal && inventoryScan) {
    const listings = new Map<string, Promise<Listing>>()
    const candidates = new Map<string, Map<string, Promise<DirectoryCandidate>>>()
    await scanInventoryPathCommands(
      directories,
      remaining,
      concurrency,
      inventoryScan.partialBudget,
      (command, dir) => {
        const byDirectory =
          candidates.get(command) ?? new Map<string, Promise<DirectoryCandidate>>()
        candidates.set(command, byDirectory)
        let candidate = byDirectory.get(dir.key)
        if (!candidate) {
          const listing = listings.get(dir.key) ?? readListing(dir)
          listings.set(dir.key, listing)
          candidate = listing.then((names) => probeCommand(command, dir, names))
          byDirectory.set(dir.key, candidate)
        }
        return candidate
      },
      (command, match) => {
        inventory.matches.set(command, match)
        if (match.user) {
          found.add(command)
          options.matches?.set(command, match.user)
          options.onMatch?.()
        }
      },
      (command, uncertain) => {
        remaining.delete(command)
        candidates.delete(command)
        if (uncertain) {
          options.unverified?.add(command)
        }
        options.onCommandComplete?.(command, uncertain)
      },
      signal
    )
    return found
  }
  // A quoted and unquoted occurrence may have different precedence, but share one physical read.
  const repeatedReads = new Map<string, Promise<DirectoryProbe[]>>()
  const scan = async (dir: PathDirectory): Promise<DirectoryProbe[]> => {
    const needsReplay = inventory && seen.has(dir.key) && seen.has(`${dir.key}\0quoted`)
    const pending = repeatedReads.get(dir.key)
    if (pending) {
      repeatedReads.delete(dir.key)
      return pending
    }
    const read = async (): Promise<DirectoryProbe[]> => {
      const listing = await readListing(dir)
      const candidates = await Promise.all(
        [...remaining]
          .filter((command) => needsReplay || needsHit(command, dir))
          .map(async (command): Promise<DirectoryProbe | undefined> => {
            const candidate = await probeCommand(command, dir, listing)
            return candidate.hit || candidate.uncertain ? { command, ...candidate } : undefined
          })
      )
      return candidates.filter((probe) => probe !== undefined)
    }
    const result = read()
    if (needsReplay) {
      repeatedReads.set(dir.key, result)
    }
    return result
  }
  const commit = (dir: PathDirectory, probes: DirectoryProbe[]): void => {
    for (const { command, hit, uncertain } of probes) {
      if (!remaining.has(command)) {
        continue
      }
      if (uncertain) {
        options.unverified?.add(command)
      }
      if (inventory) {
        const match = inventory.matches.get(command) ?? {}
        const user = recordDirectoryMatch(match, dir, { hit, uncertain })
        inventory.matches.set(command, match)
        if (!user) {
          continue
        }
        options.matches?.set(command, user)
      } else if (hit) {
        options.matches?.set(command, hit)
      } else {
        continue
      }
      remaining.delete(command)
      found.add(command)
    }
  }
  await scanDetectionDirectories(directories, concurrency, scan, commit, () => remaining.size === 0)
  if (inventory) {
    for (const [command, match] of inventory.matches) {
      if (match.user) {
        found.add(command)
      }
    }
  }
  return found
}
