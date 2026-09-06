import * as path from 'node:path'
import type { RequestContext } from './dispatcher'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { getStatusOp } from './git-handler-status-ops'
import { streamRelayGitStdout } from './git-stdout-stream'
import { capGitStatusEntries, resolveGitStatusLimit } from '../shared/git-status-limit'
import {
  buildSubmoduleInnerCommitRangeDiff,
  computeSubmodulePointerDiff,
  computeSubmoduleRangeEntries,
  findContainingSubmodule,
  listSubmodulePathsCached,
  resolveSubmoduleWorktreePath,
  resolveSubmoduleCommitRange
} from './git-handler-submodule-ops'
import { computeDiff, type GitExec } from './git-handler-ops'
import { checkIgnoredPathsOp } from './git-handler-check-ignore'
import { loadGitHistoryFromExecutor } from '../shared/git-history'
import { stableInFlightKey } from '../shared/in-flight-promise-dedupe'

function resolveSubmoduleStatusArea(
  params: Record<string, unknown>
): 'staged' | 'unstaged' | 'untracked' {
  if (params.area === 'staged' || params.area === 'unstaged' || params.area === 'untracked') {
    return params.area
  }
  return 'unstaged'
}

export class GitHandlerReadOperations extends GitHandlerOperationContext {
  async getStatus(params: Record<string, unknown>, context: RequestContext) {
    this.gitDiffReadDedupe.clear()
    return getStatusOp(this.git.bind(this), streamRelayGitStdout, params, {
      signal: context.signal
    })
  }

  // Why: fetch per-file submodule changes from the submodule worktree.
  async getSubmoduleStatus(params: Record<string, unknown>, context: RequestContext) {
    const worktreePath = params.worktreePath as string
    const submodulePath = params.submodulePath as string
    const area = resolveSubmoduleStatusArea(params)
    const staged = area === 'staged'
    const resolved = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
    const limit = resolveGitStatusLimit(params.limit)
    // Why: staged expansion only represents HEAD→index; scanning the submodule worktree is wasted work.
    const workingResult = staged
      ? { entries: [], conflictOperation: 'unknown' }
      : await getStatusOp(
          this.git.bind(this),
          streamRelayGitStdout,
          {
            ...params,
            worktreePath: resolved
          },
          { signal: context.signal }
        )
    // Why: pointer/range probes are part of the same SSH request and must not outlive its cancellation.
    const requestGit: GitExec = (args, cwd, options) =>
      this.git(args, cwd, { ...options, signal: context.signal })
    // Why: moved clean gitlinks need committed changes surfaced.
    const { fromOid, toOid } = await resolveSubmoduleCommitRange(
      requestGit,
      worktreePath,
      submodulePath,
      staged
    )
    if (fromOid && toOid && fromOid !== toOid) {
      const rangeEntries = await computeSubmoduleRangeEntries(requestGit, resolved, fromOid, toOid)
      if (staged) {
        return { ...workingResult, ...capGitStatusEntries(rangeEntries, limit) }
      }
      const rangePaths = new Set(rangeEntries.map((entry) => entry.path))
      const entries = [
        ...rangeEntries,
        ...workingResult.entries.filter((entry) => !rangePaths.has(entry.path))
      ]
      return {
        ...workingResult,
        ...capGitStatusEntries(entries, limit, workingResult)
      }
    }
    if (staged) {
      return { ...workingResult, entries: [] }
    }
    return workingResult
  }

  async checkIgnored(params: Record<string, unknown>) {
    return checkIgnoredPathsOp(this.git.bind(this), params)
  }

  async history(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    return loadGitHistoryFromExecutor(this.git.bind(this), worktreePath, {
      limit: typeof params.limit === 'number' ? params.limit : undefined,
      baseRef: typeof params.baseRef === 'string' ? params.baseRef : null
    })
  }

  async getDiff(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    // Why: validate relative paths to prevent traversal outside the worktree.
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }
    const staged = params.staged as boolean
    const compareAgainstHead = params.compareAgainstHead as boolean | undefined
    // Why: register dedupe before awaiting so identical reads coalesce.
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey(['diff', worktreePath, filePath, staged, compareAgainstHead]),
      async () => {
        // Why: route gitlink roots to pointer diffs and inner files to their submodule worktree.
        const submodulePaths = await listSubmodulePathsCached(
          this.git.bind(this),
          worktreePath,
          this.submodulePathsCache
        )
        if (submodulePaths.length > 0) {
          const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
          if (matchedSubmodule) {
            const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
            if (normalizedFilePath === matchedSubmodule) {
              return computeSubmodulePointerDiff(
                this.git.bind(this),
                worktreePath,
                matchedSubmodule,
                staged,
                compareAgainstHead
              )
            }
            const submoduleWorktreePath = resolveSubmoduleWorktreePath(
              worktreePath,
              matchedSubmodule
            )
            const innerPath = normalizedFilePath.slice(matchedSubmodule.length + 1)
            const { fromOid, toOid } = await resolveSubmoduleCommitRange(
              this.git.bind(this),
              worktreePath,
              matchedSubmodule,
              staged
            )
            // Why: a moved gitlink (clean worktree) keeps inner changes in committed history, so diff the two commits; otherwise read the working-tree blob.
            if (fromOid && toOid && fromOid !== toOid) {
              return buildSubmoduleInnerCommitRangeDiff(
                this.gitBuffer.bind(this),
                submoduleWorktreePath,
                innerPath,
                fromOid,
                toOid
              )
            }
            return computeDiff(
              this.gitBuffer.bind(this),
              submoduleWorktreePath,
              innerPath,
              staged,
              compareAgainstHead
            )
          }
        }
        return computeDiff(
          this.gitBuffer.bind(this),
          worktreePath,
          filePath,
          staged,
          compareAgainstHead
        )
      }
    )
    return this.maybeStreamResponse(result, params, context)
  }
}
