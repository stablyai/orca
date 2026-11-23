// The phone's pending comments on an item (the desktop's store, shared): each goes to the bot's host
// with its photos, and a request id where the host dedupes by one; a failure says why in a toast.
import { useEffect, useSyncExternalStore } from 'react'
import {
  BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_SKILLS_RUNTIME_CAPABILITY
} from '../../../../src/shared/bot-runtime-capabilities'
import {
  BotItemCommentMayHaveArrived,
  botItemPendingCommentText,
  createBotItemPendingCommentsHook
} from '../../../../src/shared/bots/bot-item-pending-comments'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { commentOnBotItem } from './bot-item-operations'
import { botItemWriteFailure } from './use-bot-item-moves'

const usePendingComments = createBotItemPendingCommentsHook({ useEffect, useSyncExternalStore })

export function usePhoneBotItemPendingComments({
  client,
  key,
  uid,
  events,
  hostName,
  showToast
}: {
  client: RpcClient | null
  /** One item on one host. */
  key: string
  uid: string
  events: readonly BotItemEvent[]
  hostName: string
  showToast: (message: string) => void
}) {
  const t = useMobileTranslation()
  const requestIds = useRouteCapability(BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY)
  const skills = useRouteCapability(BOTS_ITEM_COMMENT_SKILLS_RUNTIME_CAPABILITY)
  const questionIds = useRouteCapability(BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY)
  const plain = useRouteCapability(BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY)
  return usePendingComments(key, events, {
    post: async (entry) => {
      const outcome = client
        ? await commentOnBotItem(client, uid, botItemPendingCommentText(entry), {
            images: entry.paths,
            requestId: entry.requestId ?? undefined,
            skills: entry.skills,
            questionId: entry.questionId ?? undefined,
            plain: entry.plain
          })
        : ({ kind: 'not-sent' } as const)
      if (outcome.kind !== 'done') {
        const message = botItemWriteFailure(outcome, hostName, t)
        // The host's code goes along: a reply to a question since replaced is dropped, not retried.
        throw outcome.kind === 'unknown'
          ? new BotItemCommentMayHaveArrived(message)
          : Object.assign(
              new Error(message),
              outcome.kind === 'refused' ? { code: outcome.code } : {}
            )
      }
      return outcome.result
    },
    failed: (error, replaced) =>
      showToast(
        replaced
          ? t('bots.items.ask.replaced', 'The agent asked a new question. Read it, then reply.')
          : error instanceof Error
            ? error.message
            : String(error)
      ),
    requestIds,
    questionIds,
    plain,
    skills
  })
}
