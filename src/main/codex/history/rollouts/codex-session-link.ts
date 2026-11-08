import type { Dirent } from 'node:fs'
import { mkdir, readdir, readlink, rmdir, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { parseCodexRolloutThreadId } from '../index/codex-session-index-heal-state'
import {
  replaceCodexRolloutSymlinkWithHardlink,
  tryHardlinkCodexRollout
} from './codex-rollout-hardlink'

export type CodexSessionLinkPass = {
  scannedFiles: number
  linkedFiles: number
  /** Rollouts left unlinked because the filesystem cannot hardlink and a symlink was not allowed. */
  skippedFiles: number
  failedFiles: number
  /** Legacy symlinked rollouts replaced with hardlinks that Codex resume can read. */
  upgradedSymlinks: number
  /** Thread ID to rollout timestamp for source rollouts present in the target; only when collected. */
  bridgedThreads: Map<string, string>
}

const ENTRIES_PER_YIELD = 256

/**
 * Links rollouts missing from `targetCodexHomePath`, walking every source together so each target
 * directory is examined once and history the target already has costs no per-rollout call.
 */
export async function linkMissingCodexSessionRollouts(args: {
  sourceCodexHomePaths: readonly string[]
  targetCodexHomePath: string
  /** Skip rather than symlink when the filesystem cannot hardlink (cross-volume). */
  hardlinkOnly?: boolean
  /** Fill `bridgedThreads` for index healing. */
  collectThreads?: boolean
  shouldStop?: () => boolean
}): Promise<CodexSessionLinkPass> {
  const pass: CodexSessionLinkPass = {
    scannedFiles: 0,
    linkedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    upgradedSymlinks: 0,
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
      args.collectThreads === true,
      args.shouldStop ?? (() => false),
      pass
    ).visit([], [...sourceRoots.keys()])
  }
  return pass
}

type LinkOutcome = 'linked' | 'existing' | 'skipped' | 'failed'
type TargetEntryKind = 'file' | 'symlink'

class RolloutLinkWalk {
  private entriesSinceYield = 0

  constructor(
    private readonly sourceRoots: readonly string[],
    private readonly targetRoot: string,
    private readonly hardlinkOnly: boolean,
    private readonly collectThreads: boolean,
    private readonly shouldStop: () => boolean,
    private readonly pass: CodexSessionLinkPass
  ) {}

  async visit(relativeParts: readonly string[], sourceIndexes: readonly number[]): Promise<void> {
    if (this.shouldStop()) {
      return
    }
    // Rollout name to the sources holding it, in caller priority order.
    const rollouts = new Map<string, number[]>()
    const subdirectories = new Map<string, number[]>()
    for (const sourceIndex of sourceIndexes) {
      const entries = await this.readSourceDirectory(sourceIndex, relativeParts)
      for (const entry of entries ?? []) {
        if (entry.isDirectory()) {
          const childSourceIndexes = subdirectories.get(entry.name) ?? []
          childSourceIndexes.push(sourceIndex)
          subdirectories.set(entry.name, childSourceIndexes)
        } else if (entry.isFile() && isCodexRolloutFileName(entry.name)) {
          rollouts.set(entry.name, [...(rollouts.get(entry.name) ?? []), sourceIndex])
        }
        await this.yieldPeriodically()
      }
    }
    if (rollouts.size > 0) {
      await this.linkDirectory(relativeParts, rollouts)
    }
    for (const [name, childSourceIndexes] of subdirectories) {
      await this.visit([...relativeParts, name], childSourceIndexes)
    }
  }

  private async readSourceDirectory(
    sourceIndex: number,
    relativeParts: readonly string[]
  ): Promise<Dirent[] | null> {
    try {
      return await readdir(join(this.sourceRoots[sourceIndex], ...relativeParts), {
        withFileTypes: true
      })
    } catch (error) {
      // Missing history in one source is normal; other sources still fill this directory.
      if (!isDefinitiveAbsence(error)) {
        console.warn('[codex-session-link] Failed to list Codex sessions:', error)
      }
      return null
    }
  }

  private async linkDirectory(
    relativeParts: readonly string[],
    rollouts: ReadonlyMap<string, readonly number[]>
  ): Promise<void> {
    const targetDir = join(this.targetRoot, ...relativeParts)
    const targetEntries = await this.readTargetEntries(targetDir, rollouts)
    if (!targetEntries) {
      this.pass.scannedFiles += rollouts.size
      this.pass.failedFiles += rollouts.size
      return
    }
    // A directory pair sits on fixed filesystems, so one unsupported hardlink settles the rest of
    // it for this pass; a mount elsewhere under sessions still gets its own attempt.
    const unsupportedSources = new Set<number>()
    let createdDirs: { firstCreated: string | undefined } | null = null
    let linkedHere = 0
    for (const [name, sourceIndexes] of rollouts) {
      if (this.shouldStop()) {
        break
      }
      await this.yieldPeriodically()
      this.pass.scannedFiles += 1
      const targetPath = join(targetDir, name)
      const existing = targetEntries.get(name)
      let outcome: LinkOutcome
      if (existing === 'symlink') {
        outcome = await this.upgradeSymlinkedRollout(
          relativeParts,
          name,
          sourceIndexes,
          targetPath,
          unsupportedSources
        )
      } else if (existing) {
        // Rollout names carry the session UUID, so an existing name is this conversation.
        outcome = 'existing'
      } else {
        if (!createdDirs) {
          try {
            createdDirs = { firstCreated: await mkdir(targetDir, { recursive: true }) }
          } catch (error) {
            console.warn('[codex-session-link] Failed to create session directory:', error)
            this.pass.failedFiles += 1
            return
          }
        }
        outcome = await this.linkRolloutFile(
          sourceIndexes[0],
          this.sourcePath(sourceIndexes[0], relativeParts, name),
          targetPath,
          unsupportedSources
        )
        if (outcome === 'linked') {
          linkedHere += 1
          this.pass.linkedFiles += 1
        }
      }
      if (outcome === 'skipped') {
        this.pass.skippedFiles += 1
      } else if (outcome === 'failed') {
        this.pass.failedFiles += 1
      } else if (this.collectThreads) {
        const rollout = parseCodexRolloutThreadId(name)
        if (rollout) {
          this.pass.bridgedThreads.set(rollout.threadId, rollout.rolloutStamp)
        }
      }
    }
    if (linkedHere === 0 && createdDirs?.firstCreated) {
      await removeEmptyCreatedDirs(targetDir, createdDirs.firstCreated)
    }
  }

  /** Kinds of target entries named like a source rollout; null when the target cannot be read. */
  private async readTargetEntries(
    targetDir: string,
    rollouts: ReadonlyMap<string, readonly number[]>
  ): Promise<Map<string, TargetEntryKind> | null> {
    const kinds = new Map<string, TargetEntryKind>()
    try {
      for (const entry of await readdir(targetDir, { withFileTypes: true })) {
        if (rollouts.has(entry.name)) {
          kinds.set(entry.name, entry.isSymbolicLink() ? 'symlink' : 'file')
        }
        await this.yieldPeriodically()
      }
      return kinds
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return kinds
      }
      console.warn('[codex-session-link] Failed to read target sessions:', error)
      return null
    }
  }

  private async linkRolloutFile(
    sourceIndex: number,
    sourcePath: string,
    targetPath: string,
    unsupportedSources: Set<number>
  ): Promise<LinkOutcome> {
    if (!unsupportedSources.has(sourceIndex)) {
      const hardlink = await tryHardlinkCodexRollout(sourcePath, targetPath)
      if (hardlink !== 'unsupported') {
        return hardlink
      }
      unsupportedSources.add(sourceIndex)
    }
    if (this.hardlinkOnly) {
      // A symlink would be ignored by resume and dangle once its account goes.
      return 'skipped'
    }
    try {
      // Symlinks still prevent copy divergence across volumes.
      await symlink(sourcePath, targetPath, process.platform === 'win32' ? 'file' : undefined)
      return 'linked'
    } catch (error) {
      console.warn('[codex-session-link] Failed to link Codex session:', sourcePath, error)
      return 'failed'
    }
  }

  // Codex resume ignores symlinked rollouts; replace ones that point at a source when possible.
  private async upgradeSymlinkedRollout(
    relativeParts: readonly string[],
    name: string,
    sourceIndexes: readonly number[],
    targetPath: string,
    unsupportedSources: Set<number>
  ): Promise<LinkOutcome> {
    if (sourceIndexes.every((sourceIndex) => unsupportedSources.has(sourceIndex))) {
      return 'existing'
    }
    let linkTarget: string
    try {
      linkTarget = await readlink(targetPath)
    } catch {
      return 'failed'
    }
    const absoluteTarget = normalizeRuntimePathForComparison(
      isAbsolute(linkTarget) ? linkTarget : resolve(dirname(targetPath), linkTarget)
    )
    const sourceIndex = sourceIndexes.find(
      (candidate) =>
        normalizeRuntimePathForComparison(this.sourcePath(candidate, relativeParts, name)) ===
        absoluteTarget
    )
    if (sourceIndex === undefined || unsupportedSources.has(sourceIndex)) {
      return 'existing'
    }
    const replaced = await replaceCodexRolloutSymlinkWithHardlink(
      this.sourcePath(sourceIndex, relativeParts, name),
      targetPath
    )
    if (replaced === 'unsupported') {
      unsupportedSources.add(sourceIndex)
      return 'existing'
    }
    if (replaced === 'failed') {
      return 'failed'
    }
    this.pass.upgradedSymlinks += 1
    return 'existing'
  }

  private sourcePath(sourceIndex: number, relativeParts: readonly string[], name: string): string {
    return join(this.sourceRoots[sourceIndex], ...relativeParts, name)
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

function isCodexRolloutFileName(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')
}
