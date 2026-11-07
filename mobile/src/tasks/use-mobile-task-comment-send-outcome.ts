import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from './mobile-tasks-dependencies'
import { githubTaskKey } from './github-task-identity'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

export const COMMENT_SEND_UNCONFIRMED_NOTICE =
  'Not confirmed. Check the thread before sending again.'
export const COMMENT_SEND_FAILED_NOTICE = 'Not sent. Try sending it again.'

// Which draft a send came from: the item's comment box, or a reply box keyed by comment id.
export type CommentDraftSlot = 'comment' | `reply:${string}`

type CommentSend = { item: string; priorIds: ReadonlySet<string> }

type CommentSendOutcome = {
  item: string
  slot: CommentDraftSlot
  notice: string
  // Only an unconfirmed send can still turn out posted; a later thread read settles it.
  unconfirmed: { postedBody: string; priorIds: ReadonlySet<string>; clearDraft: () => void } | null
}

function itemIdentity(item: ActionableTaskItem | null): string | null {
  return item?.provider === 'github' ? githubTaskKey(item.source) : (item?.key ?? null)
}

function sameCommentText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim()
}

// A lost reply or a connection handover cannot prove the host did not post; only a refusal can.
export function isCommentSendUnconfirmed(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}

export function useMobileTaskCommentSendOutcome(model: {
  actionItem: ActionableTaskItem | null
  detailPayload: DetailPayload | null
  requestDetailRefresh: () => void
}) {
  const { actionItem, detailPayload, requestDetailRefresh } = model
  const [outcome, setOutcome] = useState<CommentSendOutcome | null>(null)
  const openItem = itemIdentity(actionItem)

  // Read only by a send, which starts after the commit that showed the thread.
  const threadRef = useRef(detailPayload)
  useLayoutEffect(() => {
    threadRef.current = detailPayload
  }, [detailPayload])

  useEffect(() => {
    const unconfirmed = outcome?.unconfirmed
    if (!unconfirmed || openItem !== outcome.item || !detailPayload) {
      return
    }
    // Matching text alone could be someone else's identical comment; without proof of authorship the draft stays.
    const landed = detailPayload.comments.some(
      (comment) =>
        comment.viewerDidAuthor === true &&
        !unconfirmed.priorIds.has(String(comment.id)) &&
        sameCommentText(comment.body, unconfirmed.postedBody)
    )
    if (landed) {
      unconfirmed.clearDraft()
      setOutcome(null)
    }
  }, [detailPayload, openItem, outcome])

  const beginCommentSend = useCallback((item: ActionableTaskItem): CommentSend => {
    setOutcome(null)
    return {
      item: itemIdentity(item) ?? '',
      priorIds: new Set(threadRef.current?.comments.map((comment) => String(comment.id)))
    }
  }, [])

  // The reconnect reload may come from gh's read cache; ask for a fresh thread so a posted comment shows.
  const holdUnconfirmedCommentSend = useCallback(
    (send: CommentSend, slot: CommentDraftSlot, postedBody: string, clearDraft: () => void) => {
      setOutcome({
        item: send.item,
        slot,
        notice: COMMENT_SEND_UNCONFIRMED_NOTICE,
        unconfirmed: { postedBody, priorIds: send.priorIds, clearDraft }
      })
      requestDetailRefresh()
    },
    [requestDetailRefresh]
  )

  const noteCommentNotSent = useCallback(
    (send: CommentSend, slot: CommentDraftSlot) =>
      setOutcome({ item: send.item, slot, notice: COMMENT_SEND_FAILED_NOTICE, unconfirmed: null }),
    []
  )

  return {
    commentSendNotice:
      outcome && outcome.item === openItem ? { slot: outcome.slot, text: outcome.notice } : null,
    beginCommentSend,
    holdUnconfirmedCommentSend,
    noteCommentNotSent
  }
}
