import type { DragReorderMove } from '../components/drag-reorder-positions'
import { useMobileQueuedMessageComposerActions } from './use-mobile-queued-message-composer-actions'
// The host owns queued drafts; render its published cards even when it cannot queue new sends.

import { useCallback, useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { agentSessionVisibleFailureFacts } from '../../../src/shared/agent-session-visible-failures'
import { mapSettledWithConcurrency } from '../../../src/shared/map-with-concurrency'
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
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileStructuredQueuedEdit,
  type MobileQueuedMessageInlineEditor
} from './use-mobile-structured-queued-edit'

const CLEAR_DELETE_CONCURRENCY = 8

// Notify only after copying into the composer, before Delete leaves.
export type MobileQueuedMessageEdit = (messageId: string, onCopied?: () => void) => Promise<boolean>

export type MobileStructuredQueuedMessageControls = {
  cards: MobileQueuedMessageCard[]
  send: (messageId: string) => Promise<boolean>
  delete: (messageId: string) => Promise<boolean>
  clear: (messageIds: string[]) => Promise<boolean>
  edit?: MobileQueuedMessageEdit
  editor?: MobileQueuedMessageInlineEditor
  move?: (move: DragReorderMove) => Promise<boolean>
  pause: MobileQueuePause
  resume: () => Promise<boolean>
  sessionKey: string
}

export function useMobileStructuredQueuedMessageControls(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  editCapable: boolean | null
  reorderCapable?: boolean
  agentName?: string
  journalItems?: readonly AgentJournalRenderItem[]
  queuedMessages: MobileQueuedMessageFeed
  queuePause: MobileQueuePause
  submissions: readonly AgentJournalSubmission[]
  agentWorking?: boolean
  mutate: MobileStructuredAgentMutate
  // Without a live composer or a successful copy, Edit must refuse.
  appendComposerText: ((text: string) => boolean) | undefined
  onSendError: (message: string) => void
  onActionResolved?: () => void
}): MobileStructuredQueuedMessageControls {
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
  const cards = useMemo(
    () =>
      mobileQueuedMessageCards(orderedMessages, submissions, {
        agentWorking,
        agentName: args.agentName,
        statedFailures: queuedMessages?.some((draft) => draft.state === 'returned')
          ? agentSessionVisibleFailureFacts(args.journalItems ?? [])
          : []
      }),
    [agentWorking, args.agentName, args.journalItems, orderedMessages, queuedMessages, submissions]
  )
  const { begin: beginInlineEdit, editor } = useMobileStructuredQueuedEdit({
    ...args,
    enabled: args.enabled && args.editCapable === true,
    messages: queuedMessages,
    cards
  })
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
      const card = cards.find((candidate) => candidate.messageId === messageId)
      // Copy before Delete so refusal or lost reply cannot lose text; failed deletion leaves both copies visible.
      // Never delete without a copy, and never turn command text into an editable message draft.
      if (!card || card.command || !appendComposerText?.(card.text)) {
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
      cards,
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
  const pause = mobileQueueHasResumableCard(cards) ? queuePause : null
  return {
    cards,
    send,
    delete: deleteDraft,
    clear,
    edit: args.editCapable === null ? undefined : edit,
    editor,
    move: composerActions.move,
    pause,
    resume,
    sessionKey
  }
}
