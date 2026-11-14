import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { hookMount, performHookAction } from '../hook-mount'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'
import type { PrSidebarState } from '../../../source-control/review/pull-request/mobile-pr-sidebar-state'
import type { useMobilePrSidebarController as UseMobilePrSidebarController } from '../../../source-control/review/pull-request/use-mobile-pr-sidebar-controller'
import type { useMobilePrCommentActions as UseMobilePrCommentActions } from '../../../source-control/review/pull-request/comments/use-mobile-pr-comment-actions'
import { legacyShellStatusFixture } from '../legacy-shell-status-fixture'

const HOST = 'host-1'
const WORKTREE = 'repo-9::/w'
const BRANCH = 'feature'

// What the PR panel shows, so a recording sees it stay put (or roll back) while a write settles.
function projectPrState(state: PrSidebarState | undefined): unknown {
  if (!state) {
    return 'unmounted'
  }
  if (state.kind !== 'ready') {
    return state
  }
  const { pr, details, checks, checksError } = state.data
  return {
    kind: state.kind,
    refreshFailed: state.refreshFailed ?? false,
    pr: { number: pr.number, title: pr.title, headSha: pr.headSha ?? null },
    checks: checks.map((check) => `${check.name}:${check.conclusion ?? check.status}`),
    checksError,
    comments:
      details === null
        ? 'loading'
        : details.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            resolved: comment.isResolved ?? false
          }))
  }
}

// The real PR tab reads and comment writes over one document's query cache.
export function prSidebarMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.pr-sidebar': ({ client: suppliedClient }) => {
      const client = legacyShellStatusFixture(suppliedClient)
      const useController = modules.load<{
        useMobilePrSidebarController: typeof UseMobilePrSidebarController
      }>(
        'mobile/src/source-control/review/pull-request/use-mobile-pr-sidebar-controller.ts'
      ).useMobilePrSidebarController
      const useCommentActions = modules.load<{
        useMobilePrCommentActions: typeof UseMobilePrCommentActions
      }>(
        'mobile/src/source-control/review/pull-request/comments/use-mobile-pr-comment-actions.ts'
      ).useMobilePrCommentActions
      let controller: ReturnType<typeof useController> | undefined
      let comments: ReturnType<typeof useCommentActions> | undefined
      let queryClient: QueryClient | undefined
      const hook = hookMount(() => {
        queryClient = useQueryClient()
        controller = useController({
          hostId: HOST,
          client,
          connState: 'connected',
          worktreeId: WORKTREE,
          branch: BRANCH,
          headSha: null,
          demand: 'details'
        })
        const shown = controller.prSidebarState
        const pr = shown.kind === 'ready' ? shown.data.pr : null
        comments = useCommentActions({
          hostId: HOST,
          client,
          connState: 'connected',
          worktreeId: WORKTREE,
          prNumber: pr?.number ?? 0,
          prRepo: pr?.prRepo ?? null,
          queries: controller.prQueries
        })
      })
      const firstThreadComment = () => {
        const shown = controller?.prSidebarState
        const found =
          shown?.kind === 'ready'
            ? shown.data.details?.comments.find((comment) => comment.threadId)
            : undefined
        if (!found) {
          throw new Error('The PR shows no review thread to act on')
        }
        return found
      }
      return {
        action(name) {
          if (name === 'mount' || name === 'load') {
            return hook.mount()
          }
          if (name === 'post-comment') {
            return performHookAction(() => comments!.addRootComment('recorded comment'))
          }
          if (name === 'resolve-thread') {
            return performHookAction(() => comments!.toggleResolve(firstThreadComment()))
          }
          // Coming back to a stale PR: a revalidation that builds on the cached review.
          if (name === 'revisit') {
            return performHookAction(() =>
              queryClient!.invalidateQueries({
                predicate: (query) => query.queryKey[2] === 'pr.forBranch'
              })
            )
          }
          if (name === 'refresh') {
            return performHookAction(() => controller!.refetchPRSidebar({ refresh: true }))
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          throw new Error(`Unknown pr sidebar action: ${name}`)
        },
        state: () => ({
          pr: projectPrState(controller?.prSidebarState),
          commentError: comments?.error ?? null
        }),
        dispose: hook.unmount
      }
    }
  }
}
