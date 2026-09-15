import type { MountAdapter } from '../recording-scenario'
import { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'repo42::/p'

/**
 * Source-control senders mounted as plain functions: each one is an exported async call that
 * takes a client, so no React host is needed and the recorded state is the function's own answer.
 */
export function sourceControlMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'source-control.branch-base-ref': ({ client }) => {
      const resolve = modules.load<typeof import('../../../source-control/mobile-branch-base-ref')>(
        'mobile/src/source-control/mobile-branch-base-ref.ts'
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
      const history = modules.load<typeof import('../../../source-control/mobile-git-history')>(
        'mobile/src/source-control/mobile-git-history.ts'
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
      const ai = modules.load<typeof import('../../../source-control/mobile-commit-message-ai')>(
        'mobile/src/source-control/mobile-commit-message-ai.ts'
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
      const link = modules.load<typeof import('../../../source-control/mobile-pr-link')>(
        'mobile/src/source-control/mobile-pr-link.ts'
      )

      let outcome: unknown = 'unlinked'
      let linkedPR: unknown = 'unread'

      return {
        action(name) {
          if (name === 'read') {
            return link.fetchWorktreeLinkedPR(client, WORKTREE).then((value) => {
              linkedPR = value

              return value
            })
          }

          const request =
            name === 'unlink'
              ? link.unlinkMobilePr(client, WORKTREE)
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
    },
    'source-control.session-diff-reveal': ({ client }) => {
      const reveal = modules.load<
        typeof import('../../../source-control/reveal-mobile-source-control-session-diff')
      >(
        'mobile/src/source-control/reveal-mobile-source-control-session-diff.ts'
      ).revealMobileSourceControlSessionDiff

      let result: unknown = 'unrevealed'
      let current = true

      return {
        action(name, args) {
          if (name === 'cancel') {
            current = false

            return
          }

          return reveal({
            client,
            worktreeId: WORKTREE,
            relativePath: 'src/app.ts',
            tabMode: args.tabMode === 'edit' ? 'edit' : 'diff',
            staged: args.staged === true,
            isCurrent: () => current
          }).then((value) => {
            result = value

            return value
          })
        },
        state: () => ({ result }),
        dispose: () => {}
      }
    }
  }
}
