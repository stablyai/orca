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
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey([
        'branchDiff',
        worktreePath,
        baseRef,
        headOid ?? null,
        options.includePatch ?? null,
        options.filePath ?? null,
        options.oldPath ?? null
      ]),
      () => {
        if (
          headOid &&
          isFullGitObjectId(baseRef) &&
          options.includePatch === true &&
          typeof options.filePath === 'string' &&
          options.filePath.length > 0
        ) {
          return branchDiffEntryAtPinnedOids(
            this.gitBuffer.bind(this),
            worktreePath,
            baseRef,
            headOid,
            options.filePath,
            options.oldPath
          )
        }
        return branchDiffEntries(
          this.git.bind(this),
          this.gitBuffer.bind(this),
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
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey([
        'commitDiff',
        worktreePath,
        args.commitOid,
        args.parentOid ?? null,
        args.filePath,
        args.oldPath ?? null
      ]),
      () => commitDiffEntry(this.gitBuffer.bind(this), worktreePath, args)
    )
    return this.maybeStreamResponse(result, params, context)
  }
}
