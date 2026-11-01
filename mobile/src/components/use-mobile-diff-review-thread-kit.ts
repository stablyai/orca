import { useCallback, useMemo, useState } from 'react'
import { groupPRComments, type PRCommentGroup } from '../../../src/shared/pr-comment-groups'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { useMobilePrCommentActions } from '../session/use-mobile-pr-comment-actions'
import { useMobilePrAiTriage, type MobilePrAiTriage } from '../session/use-mobile-pr-ai-triage'
import { usePRBotAuthorOverrides } from '../session/use-pr-bot-author-overrides'
import { useHostProtocolGates } from './host-protocol-gates-context'
import type { PrAskToFix, PrThreadActions } from './pr-sidebar/PrThreadRow'
import { usePrThreadActions } from './pr-sidebar/use-pr-thread-actions'
import { usePrAskToFix } from './pr-sidebar/use-pr-ask-to-fix'
import { livePrDetails } from './pr-sidebar/use-mobile-pr-tab'

/** What a thread under a diff line needs to act like one on the Comments screen. */
export type MobileDiffThreadKit = {
  actions: PrThreadActions | undefined
  botAuthorOverrides: ReadonlySet<string>
  askToFix: (group: PRCommentGroup) => PrAskToFix | undefined
  triage: MobilePrAiTriage
  /** The thread whose finding was last sent to an agent; its launch notice shows under it. */
  launchedThreadId: string | null
  /** The last reply/resolve/edit failure, which the screen shows under the diff. */
  error: string | null
}

export function useMobileDiffReviewThreadKit(
  controller: ReturnType<typeof useMobileDiffReviewController>
): MobileDiffThreadKit {
  const { client, connState, worktreeId, github, prSidebarState } = controller
  const refetchPR = controller.refetchPRSidebar
  const refetchThreads = useCallback(async () => {
    await refetchPR({ includeDetails: true })
  }, [refetchPR])
  const commentActions = useMobilePrCommentActions({
    client,
    connState,
    worktreeId,
    prNumber: github?.prNumber ?? 0,
    prRepo: github?.prRepo ?? null,
    refetch: refetchThreads
  })
  const actions = usePrThreadActions(github ? commentActions : undefined, github?.prRepo)
  const details = prSidebarState.kind === 'ready' ? prSidebarState.data.details : null
  const botAuthorOverrides = usePRBotAuthorOverrides(client, connState, details)
  const { hostCapabilities, statusPending, statusReadable } = useHostProtocolGates()
  const triage = useMobilePrAiTriage({
    client,
    connState,
    worktreeId,
    workspaceLabel: controller.worktreeLabel,
    hostCapabilities,
    hostStatusPending: statusPending,
    hostStatusReadable: statusReadable
  })
  const groups = useMemo(() => groupPRComments(livePrDetails(details)?.comments ?? []), [details])
  const ask = usePrAskToFix({
    client,
    worktreeId,
    review: prSidebarState.kind === 'ready' ? prSidebarState.data.pr : null,
    groups,
    triage,
    botAuthorOverrides
  })
  const [launchedThreadId, setLaunchedThreadId] = useState<string | null>(null)
  const askToFix = (group: PRCommentGroup): PrAskToFix | undefined => {
    const target = ask.askToFix(group)
    return target && group.kind === 'thread'
      ? {
          ...target,
          onPress: () => {
            setLaunchedThreadId(group.threadId)
            target.onPress()
          }
        }
      : target
  }
  return {
    actions,
    botAuthorOverrides,
    askToFix,
    triage,
    launchedThreadId,
    error: commentActions.error
  }
}
