import type { Dirent } from 'node:fs'
import { lstat, mkdir, readdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { parseCodexRolloutThreadId } from '../index/codex-session-index-heal-state'
import { isCodexSessionRolloutFileName } from './codex-session-file-listing'
import { linkCodexSessionFileAsync } from './codex-session-link'

export type CodexSessionLinkPass = {
  scannedFiles: number
  linkedFiles: number
  /** Rollouts left unlinked because only a hardlink was allowed and none could be made. */
  skippedFiles: number
  /** Thread ID to rollout timestamp for history present in the target home. */
  bridgedThreads: Map<string, string>
}

// Up to this many rollouts, per-path checks cost less than listing a wide target directory.
const SPARSE_TARGET_LOOKUP_LIMIT = 4
const ENTRIES_PER_YIELD = 256

/**
 * Links rollouts missing from the target by diffing directory listings off the main thread, so
 * history the target already has costs no per-rollout synchronous call. Sources are walked
 * together so each target directory is examined once; earlier sources are tried first.
 */
export async function linkMissingCodexSessionRollouts(args: {
  sourceCodexHomePaths: readonly string[]
  targetCodexHomePath: string
  /** Skip rather than symlink when a hardlink fails (cross-volume): for the user's own ~/.codex. */
  hardlinkOnly?: boolean
  shouldStop?: () => boolean
}): Promise<CodexSessionLinkPass> {
  const pass: CodexSessionLinkPass = {
    scannedFiles: 0,
    linkedFiles: 0,
    skippedFiles: 0,
    bridgedThreads: new Map()
  }
  const sourceRoots = dedupeSourceHomes(args.sourceCodexHomePaths, args.targetCodexHomePath).map(
    (home) => join(home, 'sessions')
  )
  if (sourceRoots.length > 0) {
    await new RolloutLinkWalk(
      sourceRoots,
      join(args.targetCodexHomePath, 'sessions'),
      args.hardlinkOnly === true,
      args.shouldStop ?? (() => false),
      pass
    ).visit([])
  }
  return pass
}

type TargetEntry = 'present' | 'dangling'

class RolloutLinkWalk {
  private entriesSinceYield = 0

  constructor(
    private readonly sourceRoots: readonly string[],
    private readonly targetRoot: string,
    private readonly hardlinkOnly: boolean,
    private readonly shouldStop: () => boolean,
    private readonly pass: CodexSessionLinkPass
  ) {}

  async visit(relativeParts: readonly string[]): Promise<void> {
    if (this.shouldStop()) {
      return
    }
    // Rollout name to every source directory holding it, in caller priority order.
    const rollouts = new Map<string, string[]>()
    const subdirectories = new Set<string>()
    for (const sourceRoot of this.sourceRoots) {
      const sourceDir = join(sourceRoot, ...relativeParts)
      for (const entry of (await readSourceDirectory(sourceDir)) ?? []) {
        if (entry.isDirectory()) {
          subdirectories.add(entry.name)
        } else if (entry.isFile() && isCodexSessionRolloutFileName(entry.name)) {
          const holders = rollouts.get(entry.name)
          if (holders) {
            holders.push(sourceDir)
          } else {
            rollouts.set(entry.name, [sourceDir])
          }
        }
        await this.yieldPeriodically()
      }
    }
    if (rollouts.size > 0) {
      await this.linkDirectory(join(this.targetRoot, ...relativeParts), rollouts)
    }
    for (const name of subdirectories) {
      await this.visit([...relativeParts, name])
    }
  }

  private async linkDirectory(
    targetDir: string,
    rollouts: ReadonlyMap<string, readonly string[]>
  ): Promise<void> {
    const targetEntries = await this.readTargetEntries(targetDir, rollouts)
    if (!targetEntries) {
      this.pass.scannedFiles += rollouts.size
      return
    }
    let createdDirs: { firstCreated: string | undefined } | null = null
    let linkedHere = 0
    let examined = 0
    for (const [name, sourceDirs] of rollouts) {
      if (this.shouldStop()) {
        break
      }
      await this.yieldPeriodically()
      examined += 1
      this.pass.scannedFiles += 1
      const targetEntry = targetEntries.get(name)
      // A dangling link blocks the name, and resume cannot read it; leave it out of healing.
      if (targetEntry === 'dangling') {
        continue
      }
      let outcome: 'linked' | 'existing' | 'skipped' | 'failed' = 'existing'
      // Rollout names carry the session UUID, so an existing name is this conversation.
      if (!targetEntry) {
        if (!createdDirs) {
          try {
            createdDirs = { firstCreated: await mkdir(targetDir, { recursive: true }) }
          } catch (error) {
            console.warn('[codex-session-link] Failed to create session directory:', error)
            // The rest of this directory cannot be linked either.
            this.pass.scannedFiles += rollouts.size - examined
            return
          }
        }
        outcome = await this.linkFromFirstUsableSource(name, sourceDirs, targetDir)
      }
      if (outcome === 'skipped') {
        this.pass.skippedFiles += 1
        continue
      }
      if (outcome === 'failed') {
        continue
      }
      if (outcome === 'linked') {
        linkedHere += 1
        this.pass.linkedFiles += 1
      }
      const rollout = parseCodexRolloutThreadId(name)
      if (rollout) {
        this.pass.bridgedThreads.set(rollout.threadId, rollout.rolloutStamp)
      }
    }
    if (linkedHere === 0 && createdDirs?.firstCreated) {
      // A skipped link leaves no folders behind.
      await removeEmptyCreatedDirs(targetDir, createdDirs.firstCreated)
    }
  }

  // Each source holding the name gets its own attempt, as a per-source pass would give it.
  private async linkFromFirstUsableSource(
    name: string,
    sourceDirs: readonly string[],
    targetDir: string
  ): Promise<'linked' | 'existing' | 'skipped' | 'failed'> {
    let outcome: 'linked' | 'existing' | 'skipped' | 'failed' = 'failed'
    for (const sourceDir of sourceDirs) {
      outcome = await linkCodexSessionFileAsync(join(sourceDir, name), join(targetDir, name), {
        hardlinkOnly: this.hardlinkOnly
      })
      if (outcome === 'existing' && !(await isTargetPresent(join(targetDir, name)))) {
        // A dangling link another writer made after the listing is not readable history.
        return 'failed'
      }
      if (outcome === 'linked' || outcome === 'existing') {
        return outcome
      }
    }
    return outcome
  }

  /** Target entries named like a source rollout; null when the target cannot be read. */
  private async readTargetEntries(
    targetDir: string,
    rollouts: ReadonlyMap<string, readonly string[]>
  ): Promise<Map<string, TargetEntry> | null> {
    const entries = new Map<string, TargetEntry>()
    try {
      if (rollouts.size <= SPARSE_TARGET_LOOKUP_LIMIT) {
        for (const name of rollouts.keys()) {
          const entry = await readTargetEntry(join(targetDir, name))
          if (entry) {
            entries.set(name, entry)
          }
        }
        return entries
      }
      for (const dirent of await readdir(targetDir, { withFileTypes: true })) {
        if (rollouts.has(dirent.name)) {
          entries.set(
            dirent.name,
            dirent.isSymbolicLink()
              ? await resolveSymlinkEntry(join(targetDir, dirent.name))
              : 'present'
          )
        }
        await this.yieldPeriodically()
      }
      return entries
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return entries
      }
      console.warn('[codex-session-link] Failed to read target sessions:', error)
      return null
    }
  }

  // Wide directories must not hold the main thread while names are matched.
  private async yieldPeriodically(): Promise<void> {
    this.entriesSinceYield += 1
    if (this.entriesSinceYield >= ENTRIES_PER_YIELD) {
      this.entriesSinceYield = 0
      await yieldToEventLoop()
    }
  }
}

async function readSourceDirectory(sourceDir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    // A source without this directory is normal; other sources may still fill it.
    if (!isDefinitiveAbsence(error)) {
      console.warn('[codex-session-link] Failed to list Codex sessions:', error)
    }
    return null
  }
}

async function readTargetEntry(targetPath: string): Promise<TargetEntry | null> {
  try {
    const entry = await lstat(targetPath)
    return entry.isSymbolicLink() ? await resolveSymlinkEntry(targetPath) : 'present'
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

async function isTargetPresent(targetPath: string): Promise<boolean> {
  try {
    return (await readTargetEntry(targetPath)) === 'present'
  } catch {
    return false
  }
}

async function resolveSymlinkEntry(targetPath: string): Promise<TargetEntry> {
  try {
    await stat(targetPath)
    return 'present'
  } catch {
    return 'dangling'
  }
}

async function removeEmptyCreatedDirs(deepest: string, firstCreated: string): Promise<void> {
  for (let dir = deepest; ; dir = dirname(dir)) {
    try {
      // Non-recursive: a directory something else wrote into in the meantime stays.
      await rmdir(dir)
    } catch {
      return
    }
    if (dir === firstCreated) {
      return
    }
  }
}

function dedupeSourceHomes(
  sourceCodexHomePaths: readonly string[],
  targetCodexHomePath: string
): string[] {
  const seen = new Set([normalizeRuntimePathForComparison(targetCodexHomePath)])
  return sourceCodexHomePaths.filter((sourceHomePath) => {
    const key = normalizeRuntimePathForComparison(sourceHomePath)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}
