import { existsSync, opendirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../shared/node-bounded-file-reader'

export const TERMINAL_HISTORY_GC_MAX_DISCOVERY_ENTRIES = 100_000
export const TERMINAL_HISTORY_GC_MAX_WSL_DISTROS = 256
export const TERMINAL_HISTORY_GC_MAX_FILES_PER_WORKTREE = 64
export const TERMINAL_HISTORY_GC_META_MAX_BYTES = 64 * 1024

export type TerminalHistoryGcLimits = {
  maxDiscoveryEntries: number
  maxFilesPerWorktree: number
  maxMetaBytes: number
  maxWslDistros: number
}

export type TerminalHistoryGcSummary = {
  capacityExceeded: boolean
  orphaned: number
  pruned: number
  totalDirs: number
  totalSizeKB: number
}

const DEFAULT_LIMITS: TerminalHistoryGcLimits = {
  maxDiscoveryEntries: TERMINAL_HISTORY_GC_MAX_DISCOVERY_ENTRIES,
  maxFilesPerWorktree: TERMINAL_HISTORY_GC_MAX_FILES_PER_WORKTREE,
  maxMetaBytes: TERMINAL_HISTORY_GC_META_MAX_BYTES,
  maxWslDistros: TERMINAL_HISTORY_GC_MAX_WSL_DISTROS
}

// Why: the live-worktree snapshot can predate a newly created history directory.
const GC_MIN_AGE_MS = 5 * 60 * 1000

class TerminalHistoryGcCapacityError extends Error {
  constructor(
    readonly resource: 'discovery entries' | 'WSL distros',
    readonly limit: number
  ) {
    super(`Terminal history GC exceeded ${limit} ${resource}`)
    this.name = 'TerminalHistoryGcCapacityError'
  }
}

class TerminalHistoryGcBudget {
  private discoveryEntries = 0
  private wslDistros = 0

  constructor(readonly limits: TerminalHistoryGcLimits) {}

  claimDiscoveryEntry(): void {
    this.discoveryEntries += 1
    if (this.discoveryEntries > this.limits.maxDiscoveryEntries) {
      throw new TerminalHistoryGcCapacityError('discovery entries', this.limits.maxDiscoveryEntries)
    }
  }

  claimWslDistro(): void {
    this.wslDistros += 1
    if (this.wslDistros > this.limits.maxWslDistros) {
      throw new TerminalHistoryGcCapacityError('WSL distros', this.limits.maxWslDistros)
    }
  }
}

type MutableTerminalHistoryGcSummary = Omit<TerminalHistoryGcSummary, 'capacityExceeded'>

export function runTerminalHistoryGarbageCollection(options: {
  mainRoot: string
  wslRoot: string
  liveWorktreeIds: Set<string>
  limits?: Partial<TerminalHistoryGcLimits>
}): TerminalHistoryGcSummary {
  const limits = resolveTerminalHistoryGcLimits(options.limits)
  const budget = new TerminalHistoryGcBudget(limits)
  const summary: TerminalHistoryGcSummary = {
    capacityExceeded: false,
    orphaned: 0,
    pruned: 0,
    totalDirs: 0,
    totalSizeKB: 0
  }

  try {
    scanTerminalHistoryRoot(options.mainRoot, options.liveWorktreeIds, budget, limits, summary)
    scanWslHistoryRoots(options.wslRoot, options.liveWorktreeIds, budget, limits, summary)
  } catch (error) {
    if (!(error instanceof TerminalHistoryGcCapacityError)) {
      throw error
    }
    summary.capacityExceeded = true
    console.warn(`[pty:history:gc] ${error.message}; remaining history will be scanned next run`)
  }
  return summary
}

export function deleteWslWorktreeHistoryDirectories(options: {
  wslRoot: string
  worktreeHash: string
  limits?: Partial<TerminalHistoryGcLimits>
}): void {
  if (!existsSync(options.wslRoot)) {
    return
  }
  const limits = resolveTerminalHistoryGcLimits(options.limits)
  const budget = new TerminalHistoryGcBudget(limits)
  try {
    forEachDirectoryEntry(options.wslRoot, (distro) => {
      budget.claimDiscoveryEntry()
      const distroRoot = join(options.wslRoot, distro)
      if (!statSync(distroRoot).isDirectory()) {
        return
      }
      budget.claimWslDistro()
      const historyPath = join(distroRoot, options.worktreeHash)
      if (existsSync(historyPath)) {
        rmSync(historyPath, { recursive: true, force: true })
      }
    })
  } catch (error) {
    if (error instanceof TerminalHistoryGcCapacityError) {
      console.warn(`[pty:history] ${error.message}; WSL cleanup stopped at the limit`)
      return
    }
    throw error
  }
}

function scanWslHistoryRoots(
  wslRoot: string,
  liveWorktreeIds: Set<string>,
  budget: TerminalHistoryGcBudget,
  limits: TerminalHistoryGcLimits,
  summary: TerminalHistoryGcSummary
): void {
  if (!existsSync(wslRoot)) {
    return
  }
  try {
    forEachDirectoryEntry(wslRoot, (distro) => {
      budget.claimDiscoveryEntry()
      const distroRoot = join(wslRoot, distro)
      try {
        if (!statSync(distroRoot).isDirectory()) {
          return
        }
        budget.claimWslDistro()
        scanTerminalHistoryRoot(distroRoot, liveWorktreeIds, budget, limits, summary)
      } catch (error) {
        if (error instanceof TerminalHistoryGcCapacityError) {
          throw error
        }
        // One unavailable distro must not discard the main-root GC result.
      }
    })
  } catch (error) {
    if (error instanceof TerminalHistoryGcCapacityError) {
      throw error
    }
    // WSL history is optional and may disappear while distributions stop.
  }
}

function scanTerminalHistoryRoot(
  root: string,
  liveWorktreeIds: Set<string>,
  budget: TerminalHistoryGcBudget,
  limits: TerminalHistoryGcLimits,
  summary: MutableTerminalHistoryGcSummary
): void {
  if (!existsSync(root)) {
    return
  }
  const now = Date.now()

  forEachDirectoryEntry(root, (entry) => {
    budget.claimDiscoveryEntry()
    const entryPath = join(root, entry)
    try {
      if (!statSync(entryPath).isDirectory()) {
        return
      }
      summary.totalDirs += 1
      const sizeEstimate = estimateHistoryDirectorySize(entryPath, budget, limits)
      summary.totalSizeKB += sizeEstimate.totalSizeKB
      if (!sizeEstimate.complete) {
        return
      }

      const meta = readTerminalHistoryMetadata(join(entryPath, 'meta.json'), limits.maxMetaBytes)
      if (!meta || liveWorktreeIds.has(meta.worktreeId)) {
        return
      }
      if (meta.createdAt) {
        const ageMs = now - new Date(meta.createdAt).getTime()
        if (ageMs < GC_MIN_AGE_MS) {
          return
        }
      }

      summary.orphaned += 1
      rmSync(entryPath, { recursive: true, force: true })
      summary.pruned += 1
      console.log(`[pty:history:gc] Pruned orphaned history: ${meta.worktreeId}`)
    } catch (error) {
      if (error instanceof TerminalHistoryGcCapacityError) {
        throw error
      }
      // One corrupt or concurrently removed history directory must not stop GC.
    }
  })
}

function estimateHistoryDirectorySize(
  directoryPath: string,
  budget: TerminalHistoryGcBudget,
  limits: TerminalHistoryGcLimits
): { complete: boolean; totalSizeKB: number } {
  let complete = true
  let fileCount = 0
  let totalSizeKB = 0
  try {
    forEachDirectoryEntry(directoryPath, (file) => {
      budget.claimDiscoveryEntry()
      fileCount += 1
      if (fileCount > limits.maxFilesPerWorktree) {
        complete = false
        return false
      }
      const fileStat = statSync(join(directoryPath, file))
      if (fileStat.isDirectory()) {
        complete = false
        return false
      }
      totalSizeKB += Math.ceil(fileStat.size / 1024)
      return undefined
    })
  } catch (error) {
    if (error instanceof TerminalHistoryGcCapacityError) {
      throw error
    }
    complete = false
  }
  return { complete, totalSizeKB }
}

function readTerminalHistoryMetadata(
  metaPath: string,
  maxBytes: number
): { worktreeId: string; createdAt?: string } | null {
  if (!existsSync(metaPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(
      readNodeFileSyncWithinLimit(metaPath, maxBytes).buffer.toString('utf8')
    ) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('worktreeId' in parsed) ||
      typeof parsed.worktreeId !== 'string' ||
      parsed.worktreeId.length === 0
    ) {
      return null
    }
    const createdAt =
      'createdAt' in parsed && typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined
    return { worktreeId: parsed.worktreeId, ...(createdAt ? { createdAt } : {}) }
  } catch {
    return null
  }
}

function forEachDirectoryEntry(
  directoryPath: string,
  visit: (entryName: string) => false | void
): void {
  const directory = opendirSync(directoryPath)
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (visit(entry.name) === false) {
        return
      }
    }
  } finally {
    try {
      directory.closeSync()
    } catch {
      // The OS may have already closed a failed directory stream.
    }
  }
}

function resolveTerminalHistoryGcLimits(
  overrides: Partial<TerminalHistoryGcLimits> = {}
): TerminalHistoryGcLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  return limits
}
