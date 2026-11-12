import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import type { LocalGitExecOptions } from '../resolution/repo-default-base-ref'
import {
  resolveBranchSnapshotIdentity,
  type BranchSnapshotIdentity
} from './branch-ref-snapshot-identity'
import { BranchRefSnapshotStore, BranchSnapshotIdentityChanged } from './branch-ref-snapshot-store'
import { subscribeGitRefChanges } from '../git-ref-change-signal'
import { readTranslatedWorktreeGraph } from '../../worktrees/catalog/worktree-list-reader'

const snapshots = new BranchRefSnapshotStore({ subscribe: subscribeGitRefChanges })

async function withIdentity<T>(
  path: string,
  git: LocalGitExecOptions,
  read: (identity: BranchSnapshotIdentity) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = await resolveBranchSnapshotIdentity(path, git)
    if (!identity) {
      throw new Error('The project is not a Git repository')
    }
    try {
      return await read(identity)
    } catch (error) {
      if (!(error instanceof BranchSnapshotIdentityChanged)) {
        throw error
      }
    }
  }
  throw new Error('The Git repository changed while reading branches. Try again.')
}

export function searchBranchRefSnapshot(
  path: string,
  query: string,
  limit: number,
  includeQualifiedRefs = true,
  git: LocalGitExecOptions = {},
  remoteOnly = false
): Promise<BaseRefSearchResult[]> {
  return withIdentity(path, git, (identity) =>
    snapshots.search(identity, query, limit, includeQualifiedRefs, remoteOnly)
  )
}

export function snapshotRemoteNames(
  path: string,
  git: LocalGitExecOptions = {}
): Promise<string[]> {
  return withIdentity(path, git, (identity) => snapshots.remoteNames(identity))
}

export function snapshotLocalBranchMetadata(path: string, git: LocalGitExecOptions = {}) {
  return withIdentity(path, git, async (identity) => {
    const [refs, worktrees, head] = await Promise.all([
      snapshots.localRefs(identity),
      readTranslatedWorktreeGraph(identity.cwd, identity.git),
      readFile(join(identity.gitDir, 'HEAD'), 'utf8').catch(() => '')
    ])
    const currentRef = /^ref: (refs\/heads\/[^\r\n]+)/.exec(head)?.[1]
    const current =
      currentRef &&
      worktrees.some(
        (worktree) => worktree.branch === currentRef && /[1-9a-f]/i.test(worktree.head)
      )
        ? currentRef.slice('refs/heads/'.length)
        : null
    const worktreePaths = new Map<string, string>()
    for (const worktree of worktrees) {
      if (worktree.branch.startsWith('refs/heads/')) {
        worktreePaths.set(worktree.branch.slice('refs/heads/'.length), worktree.path)
      }
    }
    return { refs, worktreePaths, current }
  })
}

export function _resetBranchRefSnapshotsForTests(): void {
  snapshots.reset()
}
