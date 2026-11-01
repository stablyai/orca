import type { PRCommentGroup } from '../../../../src/shared/pr-comment-groups'
import { getPRCommentGroupRoot } from '../../../../src/shared/pr-comment-groups'
import { isBotPRComment } from '../../../../src/shared/pr-comment-audience'
import { buildPRCommentsResolutionPrompt } from '../../../../src/shared/github/pr-comments-resolution-prompt'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrAiTriage } from '../../session/use-mobile-pr-ai-triage'
import { useMobileLaunchAgentLabel } from '../../session/use-mobile-launch-agent-label'
import { useHostProtocolGates } from '../host-protocol-gates-context'
import type { PrAskToFix } from './PrThreadRow'

type ReviewTarget = { number: number; title: string; url: string }

// "Ask <agent> to fix" on unresolved bot findings: one finding per launch, through desktop's Resolve comments prompt.
export function usePrAskToFix({
  client,
  worktreeId,
  review,
  groups,
  triage,
  botAuthorOverrides
}: {
  client: RpcClient | null
  worktreeId: string
  review: ReviewTarget | null
  groups: readonly PRCommentGroup[]
  triage: MobilePrAiTriage
  botAuthorOverrides: ReadonlySet<string>
}) {
  const t = useMobileTranslation()
  const { hostCapabilities } = useHostProtocolGates()
  const hasBotFindings = groups.some(
    (group) =>
      group.kind === 'thread' &&
      group.root.isResolved !== true &&
      isBotPRComment(getPRCommentGroupRoot(group), botAuthorOverrides)
  )
  const agent = useMobileLaunchAgentLabel({
    client,
    worktreeId,
    hostCapabilities,
    actionId: 'resolveComments',
    enabled: hasBotFindings
  })
  const askToFix = (group: PRCommentGroup): PrAskToFix | undefined =>
    review
      ? {
          label: agent
            ? t('pullRequest.screens.askToFix', 'Ask {{agent}} to fix', { agent })
            : t('pullRequest.screens.askAiToFix', 'Ask AI to fix'),
          busy: triage.isBusy('resolve-comments'),
          disabled: triage.availability !== 'available',
          onPress: () =>
            void triage.launch('resolve-comments', () =>
              buildPRCommentsResolutionPrompt({
                reviewKind: 'PR',
                reviewNumber: review.number,
                reviewTitle: review.title,
                reviewUrl: review.url,
                groups: [group]
              })
            )
        }
      : undefined
  return { hasBotFindings, askToFix, notice: triage.noticeFor('resolve-comments') }
}
