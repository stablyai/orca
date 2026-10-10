// The queued-draft surface the structured session exposes: cards derived from
// the published list and the Send-now / Delete / Edit actions. Shown whatever
// the queue capability says: a host that does not queue sends still publishes a
// message it kept as a card across a restart or a close, and only queueing a new
// send is gated. A host older than the queue publishes no list, so shows no cards.
// Nothing here is durable: the host owns the queue, and the published list is
// the only truth a card action ever needs.

import { useCallback, useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { agentSessionVisibleFailureFacts } from '../../../src/shared/agent-session-visible-failures'
import type {
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionSendResult
} from '../../../src/shared/agent-session-wire'
import {
  mobileQueueHasResumableCard,
  mobileQueuedMessageCards,
  type MobileQueuedMessageCard
} from './mobile-structured-queued-message-cards'
import type {
  MobileQueuedMessageFeed,
  MobileQueuePause
} from './mobile-structured-queued-message-feed'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

/** `onCopied` runs once the card's text is in the composer, before its Delete leaves. */
export type MobileQueuedMessageEdit = (messageId: string, onCopied?: () => void) => Promise<boolean>

export type MobileStructuredQueuedMessageControls = {
  /** Host-held drafts as cards above the composer. */
  cards: MobileQueuedMessageCard[]
  /** Send-now: dispatch this draft into or ahead of the running turn. */
  send: (messageId: string) => Promise<boolean>
  /** Discard the draft. */
  delete: (messageId: string) => Promise<boolean>
  /** Copy the card's shown text into the composer, then delete the card. */
  edit: MobileQueuedMessageEdit
  /** The whole queue's pause, shown above the cards; null when it sends on its own. */
  pause: MobileQueuePause
  /** Lift the queue's pause, so the waiting cards drain. */
  resume: () => Promise<boolean>
  /** The conversation these belong to; the card list's in-flight guards never outlive it. */
  sessionKey: string
}

export function useMobileStructuredQueuedMessageControls(args: {
  sessionKey: string
  agentName?: string
  journalItems?: readonly AgentJournalRenderItem[]
  queuedMessages: MobileQueuedMessageFeed
  queuePause: MobileQueuePause
  submissions: readonly AgentJournalSubmission[]
  pendingPrompt: boolean
  /** The chat shows the agent working: a command card offers no send then. */
  agentWorking?: boolean
  mutate: MobileStructuredAgentMutate
  /** The active pane's live composer, Edit's copy target; absent = Edit refuses. False when
   *  nothing was copied. */
  appendComposerText: ((text: string) => boolean) | undefined
  onSendError: (message: string) => void
  /** Called on any accepted card action, so the route can retire a held failure banner. */
  onActionResolved?: () => void
}): MobileStructuredQueuedMessageControls {
  const {
    appendComposerText,
    mutate,
    onActionResolved,
    onSendError,
    pendingPrompt,
    queuedMessages,
    queuePause,
    sessionKey,
    submissions
  } = args
  const agentWorking = args.agentWorking === true
  const cards = useMemo(
    () =>
      mobileQueuedMessageCards(queuedMessages, submissions, {
        pendingPrompt,
        agentWorking,
        agentName: args.agentName,
        statedFailures: queuedMessages?.some((draft) => draft.state === 'returned')
          ? agentSessionVisibleFailureFacts(args.journalItems ?? [])
          : [],
        queuePaused: queuePause !== null
      }),
    [
      agentWorking,
      args.agentName,
      args.journalItems,
      pendingPrompt,
      queuePause,
      queuedMessages,
      submissions
    ]
  )
  const resolved = useCallback(
    (accepted: boolean): boolean => {
      if (accepted) {
        onActionResolved?.()
      }
      return accepted
    },
    [onActionResolved]
  )
  const send = useCallback(
    async (messageId: string): Promise<boolean> =>
      resolved(
        (
          await mutate<AgentSessionSendResult>(
            'agentSession.queuedMessageSend',
            'agentSession.queuedMessageSend',
            { messageId }
          )
        ).status === 'accepted'
      ),
    [mutate, resolved]
  )
  const deleteQueued = useCallback(
    async (messageId: string, copied: boolean): Promise<boolean> => {
      const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
        'agentSession.queuedMessageDelete',
        'agentSession.queuedMessageDelete',
        { messageId }
      )
      if (result.status !== 'accepted') {
        return false
      }
      if (!result.value.deleted && result.value.disposition === 'dispatched') {
        // Delete raced the drain; the message went out and is in the transcript. After Edit's
        // copy, say so, or the composer's text reads as unsent and goes out twice.
        onSendError(
          copied
            ? 'Already sent — your text is still in the composer.'
            : 'This message was already sent.'
        )
        return false
      }
      return resolved(true)
    },
    [mutate, onSendError, resolved]
  )
  const deleteDraft = useCallback(
    (messageId: string) => deleteQueued(messageId, false),
    [deleteQueued]
  )
  const edit = useCallback<MobileQueuedMessageEdit>(
    async (messageId, onCopied) => {
      const card = cards.find((candidate) => candidate.messageId === messageId)
      // Copy-first: the text is in the composer before any RPC can fail, so no
      // Delete outcome — including a lost answer — can lose it. A failed Delete
      // leaves the card beside the copy, visibly, never a silent duplicate. No
      // copy (no composer yet, or an empty card) means no Delete: Edit never
      // removes text it did not keep.
      // A command's text is not a draft: edited, it would become a message.
      if (!card || card.command || !appendComposerText?.(card.text)) {
        return false
      }
      onCopied?.()
      return deleteQueued(messageId, true)
    },
    [appendComposerText, cards, deleteQueued]
  )
  // Through the same mutation seam as Delete: a refusal reaches the send-error banner.
  const resume = useCallback(
    async (): Promise<boolean> =>
      resolved(
        (
          await mutate<AgentSessionQueuedMessagesResumeResult>(
            'agentSession.queuedMessagesResume',
            'agentSession.queuedMessagesResume',
            {}
          )
        ).status === 'accepted'
      ),
    [mutate, resolved]
  )
  // The header shows only while Resume would send something, as on desktop.
  const pause = mobileQueueHasResumableCard(cards) ? queuePause : null
  return { cards, send, delete: deleteDraft, edit, pause, resume, sessionKey }
}
