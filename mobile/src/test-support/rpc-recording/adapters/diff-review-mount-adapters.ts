import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'repo-9::/w'

const BRANCH_COMPARE = {
  summary: {
    baseRef: 'origin/main',
    baseOid: 'base-oid',
    compareRef: 'feature',
    headOid: 'head-oid',
    mergeBase: 'merge-base',
    changedFiles: 1,
    status: 'ready'
  },
  entries: []
}

/**
 * The review screen's three loaders, mounted as the plain async senders they are. `scope` picks the
 * diff arm: a worktree item asks `git.diff`, a branch item asks `git.branchDiff` from the compare
 * summary above. Text diffs are deliberately not scripted — highlighting them reaches `lowlight`,
 * which the module loader refuses as an unspecified native dependency.
 */
export function diffReviewMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.diff-review-load': ({ client }) => {
      const loaders = modules.load<typeof import('../../../session/mobile-diff-review-loaders')>(
        'mobile/src/session/mobile-diff-review-loaders.ts'
      )
      let snapshot: unknown = 'unloaded'
      let branchCompare: unknown = 'unloaded'
      let diff: unknown = 'unloaded'
      function reviewItem(args: Record<string, unknown>) {
        const scope =
          args.scope === 'branch' ? 'branch' : args.scope === 'staged' ? 'staged' : 'unstaged'
        return {
          key: `${scope}:src/app.ts`,
          scope,
          area: scope,
          filePath: 'src/app.ts',
          status: args.status === 'deleted' ? 'deleted' : 'modified',
          title: 'app.ts',
          subtitle: 'src',
          canStage: true,
          canUnstage: false,
          canDiscard: true,
          isGeneratedOrLockFile: false,
          diffIdentity: 'identity-1',
          noteCount: 0,
          unsentNoteCount: 0,
          staleNoteCount: 0,
          isReviewed: false,
          changedSinceReview: false
        }
      }
      return {
        action(name, args) {
          if (name === 'snapshot') {
            return loaders.loadMobileDiffReviewSnapshot(client, WORKTREE).then((value) => {
              snapshot = value
              return value
            })
          }
          if (name === 'branch-compare') {
            return loaders.loadMobileDiffReviewBranchCompare(client, WORKTREE).then((value) => {
              branchCompare = value
              return value
            })
          }
          if (name === 'diff') {
            return loaders
              .loadMobileDiffReviewDiff({
                client,
                worktreeId: WORKTREE,
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only scope, filePath, oldPath, status and key.
                item: reviewItem(args) as Parameters<
                  typeof loaders.loadMobileDiffReviewDiff
                >[0]['item'],
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the branch arm reads only the compare summary's refs and oids.
                branchCompare: (args.compare === false ? null : BRANCH_COMPARE) as Parameters<
                  typeof loaders.loadMobileDiffReviewDiff
                >[0]['branchCompare']
              })
              .then((value) => {
                diff = value
                return value
              })
          }
          throw new Error(`Unknown diff review action: ${name}`)
        },
        state: () => ({ snapshot, branchCompare, diff }),
        dispose: () => {}
      }
    }
  }
}
