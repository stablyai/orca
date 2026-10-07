import fs from 'node:fs'
import type { GitStatusResult } from '../../shared/git-status-types'
import type {
  LineageGitStatusPayload,
  LineageProjectStatus,
  LineageWorktreeStatus,
  LineageCommitProjectArgs,
  LineageCommitProjectResult
} from '../../shared/fleet-lineage-types'
import { getStatus, commitChanges } from '../git/status'
import { gitExecFileAsync } from '../git/runner'
import { gitOptionsForWorktree } from '../git/git-runtime-options'
import type { LineageStoreContract } from './workspace-lineage-service'
import {
  resolveLineageTargets,
  type ResolveLineageTargetsOptions
} from './lineage-target-resolution'
export { getLineageFileDiff } from '../git/lineage-git-diff'

export type GetLineageStatusOptions = ResolveLineageTargetsOptions & {
  concurrencyLimit?: number
  gitStatusFn?: (worktreePath: string) => Promise<GitStatusResult>
}

export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length })
  let currentIndex = 0
  let activeWorkers = 0

  return new Promise((resolve, reject) => {
    if (items.length === 0) {
      resolve([])
      return
    }

    const next = () => {
      if (currentIndex >= items.length && activeWorkers === 0) {
        resolve(results)
        return
      }

      while (activeWorkers < limit && currentIndex < items.length) {
        const itemIndex = currentIndex++
        activeWorkers++
        fn(items[itemIndex])
          .then((result) => {
            results[itemIndex] = result
            activeWorkers--
            next()
          })
          .catch((err) => {
            reject(err)
          })
      }
    }

    next()
  })
}

export {
  resolveLineageTargets,
  resolveWorktreeTarget,
  type ResolveLineageTargetsOptions,
  type ResolvedLineageTargets,
  type ResolvedWorktreeTarget
} from './lineage-target-resolution'

export async function getLineageStatus(
  store: LineageStoreContract,
  parentWorkspaceKey: string,
  options: GetLineageStatusOptions = {}
): Promise<LineageGitStatusPayload> {
  if (!parentWorkspaceKey || typeof parentWorkspaceKey !== 'string') {
    throw new Error('parentWorkspaceKey is required')
  }

  const concurrencyLimit = Math.min(options.concurrencyLimit ?? 6, 6)
  const statusRunner = options.gitStatusFn ?? ((p: string) => getStatus(p))

  const { targets } = await resolveLineageTargets(store, parentWorkspaceKey, options)

  // 3. Execute git status in parallel with max 6 concurrency limit (AC 5, AC 8)
  const worktreeStatuses = await runWithConcurrencyLimit(
    targets,
    concurrencyLimit,
    async (target): Promise<{ repoName: string; status: LineageWorktreeStatus }> => {
      // hazard: local git cannot read a remote worktree; report it as unverifiable, never as clean or gone
      if (target.unverifiable) {
        return {
          repoName: target.repoName,
          status: {
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            branch: target.branchHint,
            dirtyFiles: [],
            matchedBy: target.matchedBy,
            reason: target.reasons,
            unverifiable: true
          }
        }
      }
      try {
        const res = await statusRunner(target.worktreePath)
        const branch = res.branch || res.head || target.branchHint
        const dirtyFiles = res.entries || []

        return {
          repoName: target.repoName,
          status: {
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            branch,
            dirtyFiles,
            matchedBy: target.matchedBy,
            reason: target.reasons
          }
        }
      } catch {
        // If status fails for one worktree, report empty dirty files rather than crashing the aggregation
        return {
          repoName: target.repoName,
          status: {
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            branch: target.branchHint,
            dirtyFiles: [],
            matchedBy: target.matchedBy,
            reason: target.reasons
          }
        }
      }
    }
  )

  // 4. Group primarily by Project / Repository (repoName) (AC 6)
  const projects: Record<string, LineageProjectStatus> = {}
  let totalDirtyFiles = 0

  for (const item of worktreeStatuses) {
    if (!projects[item.repoName]) {
      projects[item.repoName] = {
        repoName: item.repoName,
        worktrees: []
      }
    }
    projects[item.repoName].worktrees.push(item.status)
    totalDirtyFiles += item.status.dirtyFiles.length
  }

  return {
    status: 200,
    parentKey: parentWorkspaceKey,
    parentWorkspaceKey,
    totalDirtyFiles,
    projects
  }
}

export async function commitLineageProject(
  _store: LineageStoreContract,
  args: LineageCommitProjectArgs
): Promise<LineageCommitProjectResult> {
  const { worktreePath, message } = args
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return {
      status: 400,
      success: false,
      error: 'Commit message is required'
    }
  }

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return {
      status: 400,
      success: false,
      error: `Worktree path does not exist: ${worktreePath}`
    }
  }

  try {
    const commitResult = await commitChanges(worktreePath, message.trim())
    if (!commitResult.success) {
      return {
        status: 500,
        success: false,
        error: commitResult.error ?? 'Commit failed'
      }
    }

    // Retrieve commit hash
    let commitHash: string | undefined
    try {
      const revParse = await gitExecFileAsync(
        ['rev-parse', 'HEAD'],
        gitOptionsForWorktree(worktreePath)
      )
      commitHash = revParse.stdout.trim()
    } catch {}

    return {
      status: 200,
      success: true,
      commitHash
    }
  } catch (error) {
    return {
      status: 500,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
