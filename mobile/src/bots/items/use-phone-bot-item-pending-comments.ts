// The phone's pending comments on an item (the desktop's store, shared): each goes to the bot's host
// with its photos, and a request id where the host dedupes by one; a failure says why in a toast.
import { useEffect, useSyncExternalStore } from 'react'
import {
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
  return usePendingComments(key, events, {
    post: async (entry) => {
      const outcome = client
        ? await commentOnBotItem(client, uid, botItemPendingCommentText(entry), {
            images: entry.paths,
            requestId: entry.requestId ?? undefined,
            skills: entry.skills
          })
        : ({ kind: 'not-sent' } as const)
      if (outcome.kind !== 'done') {
        const message = botItemWriteFailure(outcome, hostName, t)
        throw outcome.kind === 'unknown'
          ? new BotItemCommentMayHaveArrived(message)
          : new Error(message)
      }
      return outcome.result
    },
    failed: (error) => showToast(error instanceof Error ? error.message : String(error)),
    requestIds,
    // The phone's ask card answers through its own send, so typed comments carry no question.
    questionIds: false,
    // Nor do they ever opt out of answering: the phone's box has no reply mark to close.
    plain: false,
    skills
  })
}
