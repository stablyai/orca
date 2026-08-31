import * as path from 'node:path'
import { GitHandlerOperationContext, GIT_BULK_CHUNK_SIZE } from './git-handler-operation-context'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../shared/git-discard-path-safety'
import { detectConflictOperation } from './git-handler-status-ops'

const BULK_CHUNK_SIZE = GIT_BULK_CHUNK_SIZE

export class GitHandlerDiscardOperations extends GitHandlerOperationContext {
  private normalizeGitPathForCompare(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  private isTrackedPathSpec(filePath: string, trackedPaths: readonly string[]): boolean {
    const normalized = this.normalizeGitPathForCompare(filePath)
    return trackedPaths.some((trackedPath) => {
      const normalizedTracked = this.normalizeGitPathForCompare(trackedPath)
      return normalizedTracked === normalized || normalizedTracked.startsWith(`${normalized}/`)
    })
  }

  private assertInWorktree(worktreePath: string, filePath: string): string {
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    // Why: empty rel or '.' means the path IS the worktree root; reject (with parent-escaping paths) so a discard can't wipe the whole worktree.
    if (
      !rel ||
      rel === '.' ||
      rel === '..' ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }
    return resolved
  }

  async discard(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      this.assertInWorktree(worktreePath, filePath)

      let tracked = false
      try {
        await this.git(
          ['ls-files', '--error-unmatch', '--', this.literalPathspec(filePath)],
          worktreePath
        )
        tracked = true
      } catch {
        // untracked
      }

      if (tracked) {
        await this.git(
          ['restore', '--worktree', '--source=HEAD', '--', this.literalPathspec(filePath)],
          worktreePath
        )
        return
      }

      await removeSafeUntrackedDiscardTarget(worktreePath, filePath, (targetPath) =>
        this.cleanUntrackedPaths(worktreePath, [targetPath])
      )
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async bulkDiscard(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    if (filePaths.length === 0) {
      return
    }
    try {
      for (const filePath of filePaths) {
        this.assertInWorktree(worktreePath, filePath)
      }

      const trackedPathSpecs: string[] = []
      for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
        const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
        const { stdout } = await this.git(
          ['ls-files', '-z', '--', ...chunk.map((p) => this.literalPathspec(p))],
          worktreePath
        )
        // Why: a selected tracked directory can make `ls-files -z` return enough descendants for push(...split) to exceed the argument limit.
        for (const trackedPathSpec of stdout.split('\0')) {
          if (trackedPathSpec) {
            trackedPathSpecs.push(trackedPathSpec)
          }
        }
      }

      const trackedPaths = filePaths.filter((filePath) =>
        this.isTrackedPathSpec(filePath, trackedPathSpecs)
      )
      const untrackedPaths = filePaths.filter(
        (filePath) => !this.isTrackedPathSpec(filePath, trackedPathSpecs)
      )
      await removeSafeUntrackedDiscardTargets(
        worktreePath,
        untrackedPaths,
        (targetPaths) => this.cleanUntrackedPaths(worktreePath, targetPaths),
        async () => {
          for (let i = 0; i < trackedPaths.length; i += BULK_CHUNK_SIZE) {
            const chunk = trackedPaths.slice(i, i + BULK_CHUNK_SIZE)
            await this.git(
              [
                'restore',
                '--worktree',
                '--source=HEAD',
                '--',
                ...chunk.map((p) => this.literalPathspec(p))
              ],
              worktreePath
            )
          }
        }
      )
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async cleanUntrackedPaths(worktreePath: string, filePaths: readonly string[]) {
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      if (chunk.length > 0) {
        // Why: Git pathspec cleanup avoids raw recursive deletion through symlinked parents.
        await this.git(
          ['clean', '-ffdx', '--', ...chunk.map((p) => this.literalPathspec(p))],
          worktreePath
        )
      }
    }
  }

  async conflictOperation(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    return detectConflictOperation(worktreePath)
  }
}
