import type { DragReorderMove } from '../../../../components/reorder/drag-reorder-positions'
import { useMobileQueuedMessageComposerActions } from './use-mobile-queued-message-composer-actions'
import { useCallback, useMemo } from 'react'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { agentSessionVisibleFailureFacts } from '../../../../../../src/shared/agent-session/failures/agent-session-visible-failures'
import { mapSettledWithConcurrency } from '../../../../../../src/shared/concurrency/map-with-concurrency'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionQueuePause
} from '../../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionSendResult } from '../../../../../../src/shared/agent-session/agent-session-wire'
import { queuedMessagesQueuePause } from '../../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import {
  composerQueuedCards,
  createWaitingAgentMailRows
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-waiting-agent-mail'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  mobileQueuedMessageCards,
  type MobileQueuedMessageCard
} from './mobile-structured-queued-message-cards'
import type { MobileStructuredAgentMutate } from '../../agent-session/use-mobile-structured-agent-mutation'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useMobileStructuredQueuedEdit } from './use-mobile-structured-queued-edit'
import type { MobileQueuedMessageInlineEditor } from './mobile-queued-message-edit-draft'
// The host owns queued drafts; render its published cards even when it cannot queue new sends.

const CLEAR_DELETE_CONCURRENCY = 8

// Notify only after copying into the composer, before Delete leaves.
export type MobileQueuedMessageEdit = (messageId: string, onCopied?: () => void) => Promise<boolean>

export type MobileStructuredQueuedMessageControls = {
  cards: MobileQueuedMessageCard[]
  /** The queue the steer shortcut presses the head of: waiting mail drawn in the transcript counts. */
  steerOrder: readonly MobileQueuedMessageCard[]
  send: (messageId: string) => Promise<boolean>
  delete: (messageId: string) => Promise<boolean>
  clear: (messageIds: string[]) => Promise<boolean>
  /** What Delete all deletes and holds: every message the host holds, waiting agent mail included. */
  clearIds: readonly string[]
  edit?: MobileQueuedMessageEdit
  editor?: MobileQueuedMessageInlineEditor
  move?: (move: DragReorderMove) => Promise<boolean>
  pause: AgentSessionQueuePause | null
  resume: () => Promise<boolean>
  sessionKey: string
  /** The host still holds this message: a card here, or another agent's mail the transcript draws. */
  holds: (messageId: string) => boolean
  /** Other agents' waiting mail, drawn after the chat's live activity instead of as cards. */
  agentMail: readonly NativeChatMessage[]
  /** Whether a waiting agent message offers Edit, which opens it in the queue's editor. */
  agentMailEditable: (messageId: string) => boolean
}

const NO_ITEMS: readonly AgentJournalRenderItem[] = []
const NO_ROWS: readonly NativeChatMessage[] = []

export function useMobileStructuredQueuedMessageControls(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  editCapable: boolean | null
  imagesCapable?: boolean
  skillsCapable?: boolean
  composerScopeKey?: string | null
  reorderCapable?: boolean
  agentName?: string
  journalItems?: readonly AgentJournalRenderItem[]
  /** The chat draws a transcript; an empty or loading one keeps agent mail as cards, with their controls. */
  transcriptShown: boolean
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  queuePause: AgentSessionQueuePause | null
  submissions: readonly AgentJournalSubmission[]
  agentWorking?: boolean
  mutate: MobileStructuredAgentMutate
  // Without a live composer or a successful copy, Edit must refuse.
  appendComposerText: ((text: string) => boolean) | undefined
  onQueuedEditNotice?: (message: string) => void
  onSendError: (message: string) => void
  onActionResolved?: () => void
}): MobileStructuredQueuedMessageControls {
  const t = useMobileTranslation()
  const {
    appendComposerText,
    mutate,
    onActionResolved,
    onSendError,
    queuedMessages,
    queuePause,
    sessionKey,
    submissions
  } = args
  const composerActions = useMobileQueuedMessageComposerActions({
    ...args,
    messages: queuedMessages,
    reorderCapable: args.reorderCapable === true
  })
  const orderedMessages = composerActions.messages
  const agentWorking = args.agentWorking === true
  // Only a returned card's caption reads the transcript, so streaming leaves the cards alone otherwise.
  const failureItems = queuedMessages?.some((draft) => draft.state === 'returned')
    ? (args.journalItems ?? NO_ITEMS)
    : null
  const allCards = useMemo(() => {
    const visibleCards = mobileQueuedMessageCards(queuedMessages, submissions, {
      agentWorking,
      queuePaused: queuePause !== null,
      agentName: args.agentName,
      statedFailures: failureItems ? agentSessionVisibleFailureFacts(failureItems) : []
    })
    // Preview changes display order; published membership and current handoff visibility stay intact.
    const visibleById = new Map(visibleCards.map((card) => [card.messageId, card]))
    return (orderedMessages ?? []).flatMap((message) => {
      const card = visibleById.get(message.messageId)
      return card ? [card] : []
    })
  }, [
    agentWorking,
    args.agentName,
    failureItems,
    orderedMessages,
    queuePause,
    queuedMessages,
    submissions,
    t
  ])
  const { begin: beginInlineEdit, editor } = useMobileStructuredQueuedEdit({
    ...args,
    enabled: args.enabled && args.editCapable === true,
    messages: queuedMessages,
    cards: allCards
  })
  const agentMailRowsOf = useMemo(() => createWaitingAgentMailRows(), [])
  const waitingAgentMail = useMemo(
    () => (args.transcriptShown ? agentMailRowsOf(queuedMessages, submissions) : NO_ROWS),
    [agentMailRowsOf, args.transcriptShown, queuedMessages, submissions]
  )
  // Agent mail waits in the transcript; only one being edited joins the queue, in its editor.
  const { cards, agentMail, mailLeads } = useMemo(
    () => composerQueuedCards(allCards, waitingAgentMail, editor?.messageId),
    [allCards, waitingAgentMail, editor?.messageId]
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
        // Delete can race dispatch; after Edit’s copy, disclose that it sent so the copy is not resent.
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
  const clear = useCallback(
    async (messageIds: string[]): Promise<boolean> => {
      if (messageIds.length === 0) {
        return false
      }
      const results = await mapSettledWithConcurrency(
        messageIds,
        CLEAR_DELETE_CONCURRENCY,
        (messageId) =>
          mutate<AgentSessionQueuedMessageDeleteResult>(
            'agentSession.queuedMessageDelete',
            'agentSession.queuedMessageDelete',
            { messageId }
          )
      )
      const dispatched = results.some(
        (result) =>
          result.status === 'fulfilled' &&
          result.value.status === 'accepted' &&
          !result.value.value.deleted &&
          result.value.value.disposition === 'dispatched'
      )
      if (dispatched) {
        onSendError('This message was already sent.')
      }
      return resolved(
        !dispatched &&
          results.every(
            (result) => result.status === 'fulfilled' && result.value.status === 'accepted'
          )
      )
    },
    [mutate, onSendError, resolved]
  )
  const edit = useCallback<MobileQueuedMessageEdit>(
    async (messageId, onCopied) => {
      if (args.editCapable) {
        if (!args.enabled) {
          onSendError('Reconnect to edit.')
          return false
        }
        return beginInlineEdit(messageId)
      }
      const card = allCards.find((candidate) => candidate.messageId === messageId)
      // Copy before Delete so refusal or lost reply cannot lose text; failed deletion leaves both copies visible.
      // Never delete without a copy, and never turn a command or a run into the owner's draft.
      if (!card || card.notEditable || !appendComposerText?.(card.text)) {
        return false
      }
      onCopied?.()
      return deleteQueued(messageId, true)
    },
    [
      appendComposerText,
      args.editCapable,
      args.enabled,
      beginInlineEdit,
      allCards,
      deleteQueued,
      onSendError
    ]
  )
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
  const pause = queuedMessagesQueuePause(cards, queuePause, waitingAgentMail.length > 0)
  // A host without in-place edits still takes Edit: it copies the text to the composer first.
  const editableIds = useMemo(
    () =>
      args.editCapable === null || (args.editCapable && editor !== undefined)
        ? new Set<string>()
        : new Set(allCards.filter((card) => !card.notEditable).map((card) => card.messageId)),
    [allCards, args.editCapable, editor]
  )
  const agentMailEditable = useCallback(
    (messageId: string): boolean => editableIds.has(messageId),
    [editableIds]
  )
  const holds = useCallback(
    (messageId: string): boolean => allCards.some((card) => card.messageId === messageId),
    [allCards]
  )
  // Delete all also takes the waiting agent mail the transcript draws, as it did when that was a card.
  const clearIds = useMemo(
    () => allCards.filter((card) => card.hold !== 'sending').map((card) => card.messageId),
    [allCards]
  )

  return {
    cards,
    steerOrder: mailLeads ? allCards : cards,
    send,
    delete: deleteDraft,
    clear,
    clearIds,
    edit: args.editCapable === null ? undefined : edit,
    editor,
    move: composerActions.move,
    pause,
    resume,
    sessionKey,
    holds,
    agentMail,
    agentMailEditable
  }
}
