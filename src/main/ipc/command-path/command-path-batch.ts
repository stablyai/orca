import path from 'node:path'
import {
  UNVERIFIED_FS_PROBE,
  InventoryFsProbes
} from '../../../shared/shell/command-resolution/inventory-fs-probes'
import {
  getExecutableNames,
  stripWindowsPathQuotes
} from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import { directoryNameKey, checkExecutableFile } from './command-path-directory'
import {
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

export type { AgentPathMatch } from './command-path-inventory-scan'

type AgentPathInventory = {
  isRuntimePath: (entry: string) => boolean
  isRuntimeTarget?: (entry: string) => Promise<boolean | typeof UNVERIFIED_FS_PROBE>
  pinPathMatches?: boolean
  matches: Map<string, AgentPathMatch>
  unresolvedHits?: Set<string>
}

function getDetectionDirectories(
  env: NodeJS.ProcessEnv,
  isWin: boolean,
  cwd: string | undefined,
  inventory?: AgentPathInventory
): PathDirectory[] {
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const directories = new Map<string, PathDirectory & { index: number }>()
  const cwdDir = isWin ? (cwd ?? process.cwd()) : ''
  const add = (dir: string, onPath: boolean) => {
    if (!isAbsolute(dir)) {
      return undefined
    }
    // Keep case-distinct Windows directories separate for case-sensitive filesystems.
    const key = isWin ? dir.replace(/[\\/]+$/, '') : dir
    const entry: PathDirectory & { index: number } = directories.get(key) ?? {
      dir,
      index: directories.size,
      user: false
    }
    entry.user ||= !inventory || (onPath && !inventory.isRuntimePath(entry.dir))
    directories.set(key, entry)
    return entry
  }
  const cwdEntry = add(cwdDir, false)
  let lastFirst = -1
  let lastUnquoted = -1
  for (const raw of (readEnvCaseInsensitive(env, 'PATH') ?? '').split(isWin ? ';' : ':')) {
    const trimmed = raw.trim()
    const original = add(isWin ? stripWindowsPathQuotes(raw) : raw, true)
    const normalized = add(isWin ? stripWindowsPathQuotes(trimmed) : trimmed, true)
    const entry = isWin ? normalized : original
    if (!entry) {
      continue
    }
    // A reused probe qualifies only if its earlier position preserves shell order.
    if (entry.first === undefined) {
      entry.first = entry.index > lastFirst
      lastFirst = Math.max(lastFirst, entry.index)
    }
    if ((!isWin || stripWindowsPathQuotes(trimmed) === trimmed) && entry.unquoted === undefined) {
      entry.unquoted = entry.index > lastUnquoted
      lastUnquoted = Math.max(lastUnquoted, entry.index)
    }
  }
  // A CWD-only hit can shadow cmd's PATH lookup.
  if (cwdEntry && !cwdEntry.user) {
    cwdEntry.first ??= true
  }
  return [...directories.values()]
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
    inventoryCommandCount?: number
    presenceOnly?: boolean
    onMatch?: () => void
    onCommandComplete?: (command: string, uncertain: boolean, pathHit: boolean) => void
  } = {}
): Promise<Set<string>> {
  const found = options.found ?? new Set<string>()
  const remaining = new Set<string>()
  const isWin = (options.platform ?? process.platform) === 'win32'
  const env = options.env ?? process.env
  const inventory = options.inventory
  const probes =
    options.probes ??
    (inventory && new InventoryFsProbes(options.signal ?? new AbortController().signal))
  const direct = new Set<string>()
  for (const command of commands.filter(Boolean)) {
    if (command.includes('/') || (isWin && command.includes('\\'))) {
      direct.add(command)
    } else {
      remaining.add(command)
    }
  }
  for (const command of direct) {
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
    options.onCommandComplete?.(command, uncertain, executable)
  }
  if (remaining.size === 0) {
    return found
  }
  const directories = getDetectionDirectories(env, isWin, options.cwd, inventory)
  const extensions = new Map(
    [...remaining].map((command) => [
      command,
      isWin ? getWindowsBatchDetectionExtensions(env, command) : ['']
    ])
  )
  const shellExtensions = new Map<string, Set<string>>(
    isWin
      ? [...remaining].map((command) => [
          command,
          new Set(getWindowsPathSearchExtensions(env, command).map((ext) => ext.toLowerCase()))
        ])
      : []
  )
  type Listing = Map<string, string> | typeof UNVERIFIED_FS_PROBE | null
  const readListing = (dir: PathDirectory, pendingCount: number): Promise<Listing> | null => {
    if (!isWin && pendingCount <= DIRECT_DETECTION_COMMAND_LIMIT) {
      return null
    }
    const read = () => readDetectionDirectoryViaWorker(dir.dir, probes !== undefined)
    return probes ? probes.read(dir.dir, 'listing', read) : read()
  }
  const probeCommand = async (
    command: string,
    dir: PathDirectory,
    listing: Listing
  ): Promise<DirectoryCandidate> => {
    const names = listing === UNVERIFIED_FS_PROBE ? null : listing
    const checked = new Set<string>()
    let uncertain = false
    let shadow = false
    let runtimeHit: true | undefined
    for (const ext of extensions.get(command) ?? []) {
      const wanted = command + ext
      const listed = names?.get(directoryNameKey(wanted))
      if (names !== null && listed === undefined) {
        continue
      }
      const candidate = joinCandidatePath(isWin, dir.dir, isWin ? (listed ?? wanted) : wanted)
      const key = isWin ? candidate.toLowerCase() : candidate
      if (checked.has(key)) {
        continue
      }
      checked.add(key)
      const outcome = await checkExecutableFile(candidate, isWin, probes)
      if (outcome === 'executable') {
        const eligible = !isWin || shellExtensions.get(command)?.has(ext.toLowerCase())
        if (inventory && probes && (dir.user || inventory.isRuntimePath(dir.dir))) {
          const target = await probes.realPath(candidate)
          const runtime =
            typeof target === 'string'
              ? await (inventory.isRuntimeTarget?.(target) ?? inventory.isRuntimePath(target))
              : target
          if (runtime === UNVERIFIED_FS_PROBE) {
            uncertain = true
            continue
          }
          const runtimePath = inventory.isRuntimePath(candidate)
          if (runtime === true || runtime === null || runtimePath) {
            if (runtime === true || runtimePath) {
              runtimeHit = true
            }
            shadow ||= Boolean(eligible)
            continue
          }
        }
        return { hit: candidate, uncertain, byName: eligible && !shadow, runtimeHit }
      }
      uncertain ||= outcome === 'unknown'
    }
    return { uncertain, shadow, runtimeHit }
  }
  const { inventoryCommandCount, signal } = options
  const concurrency =
    (inventoryCommandCount ?? commands.length) <= DIRECT_DETECTION_COMMAND_LIMIT ? 1 : 4
  await scanInventoryPathCommands<Listing>(
    directories,
    remaining,
    concurrency,
    readListing,
    probeCommand,
    (command, match, unresolvedHit) => {
      inventory?.matches.set(
        command,
        inventory.pinPathMatches ? { user: match.user, runtimeHit: match.runtimeHit } : match
      )
      if (unresolvedHit) {
        inventory?.unresolvedHits?.add(command)
      } else {
        inventory?.unresolvedHits?.delete(command)
      }
      if (match.user) {
        found.add(command)
        options.matches?.set(command, match.user)
        options.onMatch?.()
      }
    },
    (command, uncertain, pathHit) => {
      if (uncertain) {
        options.unverified?.add(command)
      }
      options.onCommandComplete?.(command, uncertain, pathHit)
    },
    { presenceOnly: options.presenceOnly, signal }
  )
  return found
}
