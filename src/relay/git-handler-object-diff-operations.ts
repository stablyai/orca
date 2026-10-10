import type { RequestContext } from './dispatcher'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { branchDiffEntries } from './git-handler-ops'
import {
  branchDiffEntryAtPinnedOids,
  isFullGitObjectId,
  parseOptionalBranchDiffHeadOid
} from './git-handler-branch-diff-ops'
import { commitDiffEntry } from './git-handler-commit-diff-ops'
import { stableInFlightKey } from '../shared/in-flight-promise-dedupe'

export class GitHandlerObjectDiffOperations extends GitHandlerOperationContext {
  async reviewDiff(params: Record<string, unknown>, context?: RequestContext) {
    const { worktreePath, mergeBase, format } = params
    if (
      typeof worktreePath !== 'string' ||
      !worktreePath ||
      worktreePath.includes('\0') ||
      !isFullGitObjectId(mergeBase) ||
      (format !== 'name-status' && format !== 'patch')
    ) {
      throw new Error('Invalid review diff request.')
    }
    const flags =
      format === 'name-status'
        ? ['--name-status']
        : ['--patch', '--minimal', '--no-color', '--no-ext-diff']
    const result = await this.git(['diff', ...flags, `${mergeBase}..HEAD`, '--'], worktreePath, {
      signal: context?.signal,
      disableOptionalLocks: true
    })
    context?.signal?.throwIfAborted()
    return this.maybeStreamResponse(result, params, context)
  }

  async branchDiff(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const headOid = parseOptionalBranchDiffHeadOid(params)
    const options = {
      includePatch: params.includePatch as boolean | undefined,
      filePath: params.filePath as string | undefined,
      oldPath: params.oldPath as string | undefined
    }
    const result = await this.gitDiffReadDedupe.lease(
      stableInFlightKey([
        'branchDiff',
        worktreePath,
        baseRef,
        headOid ?? null,
        options.includePatch ?? null,
        options.filePath ?? null,
        options.oldPath ?? null
      ]),
      context?.signal,
      (signal) => {
        if (
          headOid &&
          isFullGitObjectId(baseRef) &&
          options.includePatch === true &&
          typeof options.filePath === 'string' &&
          options.filePath.length > 0
        ) {
          return branchDiffEntryAtPinnedOids(
            this.gitBufferForSignal(signal),
            worktreePath,
            baseRef,
            headOid,
            options.filePath,
            options.oldPath
          )
        }
        return branchDiffEntries(
          this.gitForSignal(signal),
          this.gitBufferForSignal(signal),
          worktreePath,
          baseRef,
          options
        )
      }
    )
    return this.maybeStreamResponse(result, params, context)
  }

  async commitDiff(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const args = {
      commitOid: params.commitOid as string,
      parentOid: params.parentOid as string | null | undefined,
      filePath: params.filePath as string,
      oldPath: params.oldPath as string | undefined
    }
    const result = await this.gitDiffReadDedupe.lease(
      stableInFlightKey([
        'commitDiff',
        worktreePath,
        args.commitOid,
        args.parentOid ?? null,
        args.filePath,
        args.oldPath ?? null
      ]),
      context?.signal,
      (signal) => commitDiffEntry(this.gitBufferForSignal(signal), worktreePath, args)
    )
    return this.maybeStreamResponse(result, params, context)
  }
}
