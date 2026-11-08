import type { Dirent } from 'node:fs'
import { link, mkdir, readdir, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { parseCodexRolloutThreadId } from '../index/codex-session-index-heal-state'

export type CodexSessionLinkPass = {
  scannedFiles: number
  linkedFiles: number
  /** Rollouts left unlinked because the filesystem cannot hardlink and a symlink was not allowed. */
  skippedFiles: number
  failedFiles: number
  /** Legacy symlinked rollouts replaced with hardlinks that Codex resume can read. */
  upgradedSymlinks: number
  /** Thread ID to rollout timestamp for every source rollout now present in the target. */
  bridgedThreads: Map<string, string>
}

/**
 * Links rollouts missing from `targetCodexHomePath` by diffing complete directory listings, so
 * history the target already has costs no per-rollout filesystem call.
 */
export async function linkMissingCodexSessionRollouts(args: {
  sourceCodexHomePath: string
  targetCodexHomePath: string
  /** Skip rather than symlink when the filesystem cannot hardlink (cross-volume). */
  hardlinkOnly?: boolean
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
  await new RolloutLinkWalk(
    join(args.sourceCodexHomePath, 'sessions'),
    join(args.targetCodexHomePath, 'sessions'),
    args.hardlinkOnly === true,
    args.shouldStop ?? (() => false),
    pass
  ).visit([])
  return pass
}

type LinkOutcome = 'linked' | 'existing' | 'skipped' | 'failed'

class RolloutLinkWalk {
  constructor(
    private readonly sourceRoot: string,
    private readonly targetRoot: string,
    private readonly hardlinkOnly: boolean,
    private readonly shouldStop: () => boolean,
    private readonly pass: CodexSessionLinkPass
  ) {}

  async visit(relativeParts: readonly string[]): Promise<void> {
    if (this.shouldStop()) {
      return
    }
    const entries = await this.readSourceDirectory(relativeParts)
    if (!entries) {
      return
    }
    const rolloutNames = entries
      .filter((entry) => entry.isFile() && isCodexRolloutFileName(entry.name))
      .map((entry) => entry.name)
    if (rolloutNames.length > 0) {
      await this.linkDirectory(relativeParts, rolloutNames)
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.visit([...relativeParts, entry.name])
      }
    }
  }

  private async readSourceDirectory(relativeParts: readonly string[]): Promise<Dirent[] | null> {
    try {
      return await readdir(join(this.sourceRoot, ...relativeParts), { withFileTypes: true })
    } catch (error) {
      // A source home without history is normal.
      if (relativeParts.length > 0 || !isDefinitiveAbsence(error)) {
        console.warn('[codex-session-link] Failed to list Codex sessions:', error)
      }
      return null
    }
  }

  private async linkDirectory(
    relativeParts: readonly string[],
    rolloutNames: readonly string[]
  ): Promise<void> {
    const sourceDir = join(this.sourceRoot, ...relativeParts)
    const targetDir = join(this.targetRoot, ...relativeParts)
    const targetEntries = await this.readTargetEntries(targetDir)
    if (!targetEntries) {
      this.pass.scannedFiles += rolloutNames.length
      this.pass.failedFiles += rolloutNames.length
      return
    }
    let createdDirs: { firstCreated: string | undefined } | null = null
    let linkedHere = 0
    for (const name of rolloutNames) {
      if (this.shouldStop()) {
        break
      }
      this.pass.scannedFiles += 1
      const sourcePath = join(sourceDir, name)
      const targetPath = join(targetDir, name)
      const existing = targetEntries.get(name)
      let outcome: LinkOutcome
      if (existing?.isSymbolicLink()) {
        outcome = await this.upgradeSymlinkedRollout(sourcePath, targetPath)
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
        outcome = await this.linkRolloutFile(sourcePath, targetPath)
        if (outcome === 'linked') {
          linkedHere += 1
          this.pass.linkedFiles += 1
        }
      }
      if (outcome === 'skipped') {
        this.pass.skippedFiles += 1
      } else if (outcome === 'failed') {
        this.pass.failedFiles += 1
      } else {
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

  private async readTargetEntries(targetDir: string): Promise<Map<string, Dirent> | null> {
    try {
      const entries = await readdir(targetDir, { withFileTypes: true })
      return new Map(entries.map((entry) => [entry.name, entry]))
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return new Map()
      }
      console.warn('[codex-session-link] Failed to list target sessions:', error)
      return null
    }
  }

  private async linkRolloutFile(sourcePath: string, targetPath: string): Promise<LinkOutcome> {
    const hardlink = await this.tryHardlink(sourcePath, targetPath)
    if (hardlink !== 'unsupported') {
      return hardlink
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

  // Codex resume ignores symlinked rollouts; replace ones that point at this source when possible.
  private async upgradeSymlinkedRollout(
    sourcePath: string,
    targetPath: string
  ): Promise<LinkOutcome> {
    let linkTarget: string
    try {
      linkTarget = await readlink(targetPath)
    } catch {
      return 'failed'
    }
    const absoluteTarget = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(targetPath), linkTarget)
    if (absoluteTarget !== sourcePath) {
      return 'existing'
    }
    const replacementPath = `${targetPath}.orca-link-${process.pid}`
    await rm(replacementPath, { force: true })
    const hardlink = await this.tryHardlink(sourcePath, replacementPath)
    if (hardlink === 'unsupported') {
      return 'existing'
    }
    if (hardlink !== 'linked') {
      return 'failed'
    }
    try {
      await rename(replacementPath, targetPath)
      this.pass.upgradedSymlinks += 1
      return 'existing'
    } catch (error) {
      console.warn('[codex-session-link] Failed to replace symlinked rollout:', targetPath, error)
      await rm(replacementPath, { force: true })
      return 'failed'
    }
  }

  private async tryHardlink(
    sourcePath: string,
    targetPath: string
  ): Promise<'linked' | 'existing' | 'unsupported' | 'failed'> {
    try {
      await link(sourcePath, targetPath)
      return 'linked'
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        // A concurrent pass created it after the listing.
        return 'existing'
      }
      if (isUnsupportedHardlinkError(error)) {
        return 'unsupported'
      }
      // Permission and I/O errors stay retryable rather than becoming a permanent symlink.
      console.warn('[codex-session-link] Failed to hardlink Codex session:', sourcePath, error)
      return 'failed'
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

function isCodexRolloutFileName(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')
}

/** The filesystem pair cannot hold a hardlink at all; anything else may succeed on retry. */
export function isUnsupportedHardlinkError(error: unknown): boolean {
  return ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].some((code) => hasErrorCode(error, code))
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
