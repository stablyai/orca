import * as path from 'node:path'
import type { RequestContext } from './dispatcher'
import type { GitStashFile, GitStashMutationTarget } from '../shared/git-stash'
import {
  isFullGitObjectId,
  isGitStashRef,
  parseGitStashFiles,
  parseGitStashList
} from '../shared/git-stash'
import { GitHandlerOperationContext } from './git-handler-operation-context'

function worktreePathFrom(params: Record<string, unknown>): string {
  const worktreePath = params.worktreePath
  if (
    typeof worktreePath !== 'string' ||
    worktreePath.length === 0 ||
    worktreePath.includes('\0') ||
    !path.isAbsolute(worktreePath)
  ) {
    throw new Error('invalid_worktree_path')
  }
  return worktreePath
}

function stashTargetFrom(params: Record<string, unknown>): GitStashMutationTarget {
  if (!isGitStashRef(params.ref as string) || !isFullGitObjectId(params.expectedCommitId)) {
    throw new Error('invalid_stash_revision')
  }
  return { ref: params.ref as string, expectedCommitId: params.expectedCommitId }
}

export class GitHandlerStashOperations extends GitHandlerOperationContext {
  async list(params: Record<string, unknown>, context: RequestContext) {
    const result = await this.git(
      ['stash', 'list', '--format=%gd%x00%H%x00%an%x00%ae%x00%at%x00%s'],
      worktreePathFrom(params),
      { signal: context.signal }
    )
    return parseGitStashList(result.stdout)
  }

  async files(params: Record<string, unknown>, context: RequestContext): Promise<GitStashFile[]> {
    const worktreePath = worktreePathFrom(params)
    const target = stashTargetFrom(params)
    const options = { signal: context.signal }
    const revision = await this.git(['rev-list', '--parents', '-n', '1', target.ref, '--'], worktreePath, options)
    const [stashCommit = '', trackedParent = '', , untrackedCommit] = revision.stdout.trim().split(/\s+/)
    if (!isFullGitObjectId(stashCommit) || !isFullGitObjectId(trackedParent)) {
      throw new Error('invalid_stash_revision')
    }
    if (stashCommit.toLowerCase() !== target.expectedCommitId.toLowerCase()) {
      throw new Error('stash_revision_changed')
    }
    const trackedResult = await this.git(
      ['diff', '--name-status', '-z', trackedParent, stashCommit, '--'],
      worktreePath,
      options
    )
    const tracked = parseGitStashFiles(trackedResult.stdout).map((file) => ({ ...file, commitId: stashCommit }))
    if (!untrackedCommit) {
      return tracked
    }
    if (!isFullGitObjectId(untrackedCommit)) {
      throw new Error('invalid_stash_revision')
    }
    const untrackedResult = await this.git(
      ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', untrackedCommit, '--'],
      worktreePath,
      options
    )
    return tracked
      .concat(parseGitStashFiles(untrackedResult.stdout).map((file) => ({ ...file, commitId: untrackedCommit })))
      .slice(0, 2000)
  }

  async create(params: Record<string, unknown>): Promise<void> {
    const worktreePath = worktreePathFrom(params)
    const args = ['stash', 'push']
    if (params.includeUntracked === true) {
      args.push('--include-untracked')
    }
    if (params.keepIndex === true) {
      args.push('--keep-index')
    }
    if (typeof params.message === 'string' && params.message.trim()) {
      args.push('--message', params.message.trim().slice(0, 500))
    }
    await this.runWithGitReadCacheClear(() => this.git(args, worktreePath))
  }

  async mutate(action: 'apply' | 'pop' | 'drop', params: Record<string, unknown>): Promise<void> {
    const worktreePath = worktreePathFrom(params)
    const target = stashTargetFrom(params)
    await this.runWithGitReadCacheClear(async () => {
      const revision = await this.git(
        ['rev-parse', '--verify', `${target.ref}^{commit}`, '--'],
        worktreePath
      )
      if (revision.stdout.trim().toLowerCase() !== target.expectedCommitId.toLowerCase()) {
        throw new Error('stash_revision_changed')
      }
      if (action === 'apply') {
        await this.git(['stash', 'apply', target.expectedCommitId], worktreePath)
        return
      }
      if (action === 'pop') {
        await this.git(['stash', 'apply', target.expectedCommitId], worktreePath)
        const current = await this.git(
          ['rev-parse', '--verify', `${target.ref}^{commit}`, '--'],
          worktreePath
        )
        if (current.stdout.trim().toLowerCase() !== target.expectedCommitId.toLowerCase()) {
          throw new Error('stash_revision_changed')
        }
      }
      await this.git(['stash', 'drop', target.ref], worktreePath)
    })
  }
}
