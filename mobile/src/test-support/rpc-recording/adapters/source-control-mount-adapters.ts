import type * as MobileBranchBaseRefModule from '../../../source-control/branches/mobile-branch-base-ref'
import type * as MobileGitHistoryModule from '../../../source-control/history/mobile-git-history'
import type * as MobileCommitMessageAiModule from '../../../source-control/commits/mobile-commit-message-ai'
import type * as MobilePrLinkModule from '../../../source-control/review/creation/mobile-pr-link'
import type { MountAdapter } from '../recording-scenario'
import { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'repo42::/p'

export function sourceControlMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'source-control.branch-base-ref': ({ client }) => {
      const resolve = modules.load<typeof MobileBranchBaseRefModule>(
        'mobile/src/source-control/branches/mobile-branch-base-ref.ts'
      ).resolveMobileBranchCompareBaseRef
      let baseRef: unknown = 'unresolved'
      return {
        action: (_name, args) =>
          resolve(client, String(args.workspace ?? WORKTREE)).then((value) => {
            baseRef = value
            return value
          }),
        state: () => ({ baseRef }),
        dispose: () => {}
      }
    },
    'source-control.git-history': ({ client }) => {
      const history = modules.load<typeof MobileGitHistoryModule>(
        'mobile/src/source-control/history/mobile-git-history.ts'
      )
      let rows: unknown = 'unloaded'
      return {
        action: () =>
          history.fetchMobileGitHistory(client, WORKTREE).then((result) => {
            rows = history.mapMobileCommitRows(result, Date.now())
            return rows
          }),
        state: () => ({ rows }),
        dispose: () => {}
      }
    },
    'source-control.commit-message': ({ client }) => {
      const ai = modules.load<typeof MobileCommitMessageAiModule>(
        'mobile/src/source-control/commits/mobile-commit-message-ai.ts'
      )
      let generated: unknown = 'ungenerated'
      return {
        action(name) {
          if (name === 'cancel') {
            return ai.cancelMobileCommitMessage(client, WORKTREE)
          }
          return ai.requestMobileCommitMessage(client, WORKTREE).then((result) => {
            generated = result
            return result
          })
        },
        state: () => ({ generated }),
        dispose: () => {}
      }
    },
    'source-control.pr-link': ({ client }) => {
      const link = modules.load<typeof MobilePrLinkModule>(
        'mobile/src/source-control/review/creation/mobile-pr-link.ts'
      )
      let outcome: unknown = 'unlinked'
      let linkedPR: unknown = 'unread'
      return {
        action(name) {
          if (name === 'read') {
            return link.fetchWorktreeGitHubPRLink(client, WORKTREE).then((value) => {
              linkedPR = value.linkedPR
              return value.linkedPR
            })
          }
          const request =
            name === 'unlink'
              ? link.unlinkMobilePr(client, WORKTREE, 12)
              : name === 'link-review'
                ? link.linkMobileHostedReview(client, WORKTREE, 'gitlab', 12, {
                    baseRef: ' origin/release '
                  })
                : link.linkMobilePr(client, WORKTREE, 12)
          return request.then((value) => {
            outcome = value
            return value
          })
        },
        state: () => ({ outcome, linkedPR }),
        dispose: () => {}
      }
    }
  }
}
