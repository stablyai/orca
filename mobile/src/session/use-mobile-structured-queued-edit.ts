import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import {
  QUEUED_EDIT_NOTICE_COPY,
  queuedCardOnScreen,
  queuedEditChangedNotice,
  queuedEditDirty,
  queuedEditHandOffTyping,
  queuedEditKeptImages,
  queuedEditStanding,
  queuedMessageEditableText,
  queuedMessageWithEdit,
  type QueuedMessageEditDraft
} from '../../../src/shared/queued-message-edit'
import type { RpcClient } from '../transport/rpc-client'
import {
  startMobileQueuedEditLease,
  type MobileQueuedEditLease
} from './mobile-queued-message-edit-lease'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

export type MobileQueuedMessageInlineEditor = {
  messageId: string
  text: string
  saving: boolean
  canSave: boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  cancel: () => void
}

// The phone edits text only, so the card's images are all kept.
type Edit = QueuedMessageEditDraft & {
  scope: string
  messageId: string
  body: AgentSessionQueuedMessage['body']
  fingerprint: string
  saving: boolean
  lease: MobileQueuedEditLease
}

export function useMobileStructuredQueuedEdit(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  messages: readonly AgentSessionQueuedMessage[] | null
  cards: readonly MobileQueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
  mutate: MobileStructuredAgentMutate
  appendComposerText: ((text: string) => boolean) | undefined
  onSendError: (text: string) => void
  onActionResolved?: () => void
}) {
  const { sessionKey, sessionId, client, enabled, mutate, onSendError, onActionResolved } = args
  const { messages, cards, submissions, appendComposerText } = args
  const clientRef = useRef({ sessionKey, client })
  const latest = useRef({ messages, cards, submissions, appendComposerText })
  useLayoutEffect(() => {
    clientRef.current = { sessionKey, client }
    latest.current = { messages, cards, submissions, appendComposerText }
  }, [appendComposerText, cards, client, messages, sessionKey, submissions])
  const active = useRef<Edit | null>(null)
  // A changed reply reopens the editor once the card publishes its newer text.
  const reopen = useRef<{ scope: string; messageId: string; stale: string } | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(() => {
    const edit = active.current
    render(null)
    edit?.lease.end()
  }, [render])
  /** Unsaved typing goes to the chat box; false when there was none to keep. */
  const handOff = useCallback((edit: Edit): boolean => {
    const typing = queuedEditHandOffTyping(edit.body, edit)
    return typing !== '' && latest.current.appendComposerText?.(typing) === true
  }, [])
  const gone = useCallback(
    (edit: Edit) => {
      if (active.current !== edit) {
        return
      }
      if (queuedEditDirty(edit.body, edit) && handOff(edit)) {
        onSendError(QUEUED_EDIT_NOTICE_COPY.editGone)
      }
      close()
    },
    [close, handOff, onSendError]
  )

  // On chat changes or unmount, hand unsaved typing back to the chat it came from: a layout
  // cleanup runs before the composer's append is repointed at the next chat.
  useLayoutEffect(() => {
    return () => {
      const edit = active.current
      active.current = null
      reopen.current = null
      setShown(null)
      if (edit && queuedEditDirty(edit.body, edit)) {
        handOff(edit)
      }
      edit?.lease.end()
    }
  }, [handOff, sessionKey, args.chatActive])

  const begin = useCallback(
    async (messageId: string): Promise<boolean> => {
      reopen.current = null
      if (active.current || !enabled || !client || !sessionId) {
        return false
      }
      const message = messages?.find((entry) => entry.messageId === messageId)
      const text = message ? queuedMessageEditableText(message.body) : null
      if (!message || text === null) {
        return false
      }
      const fingerprint = agentSessionSendBodyFingerprint(sessionId, message.body)
      const edit: Edit = {
        scope: sessionKey,
        messageId,
        body: message.body,
        text,
        kept: queuedEditKeptImages(message.body),
        added: [],
        fingerprint,
        saving: false,
        lease: startMobileQueuedEditLease({
          getClient: () =>
            clientRef.current.sessionKey === sessionKey ? clientRef.current.client : client,
          sessionId,
          messageId,
          expectedBodyFingerprint: fingerprint
        })
      }
      render(edit)
      void edit.lease.acquired.then(
        (answer) => {
          if (!isOpen(active, edit) || edit.saving) {
            return
          }
          // Sent, removed or edited elsewhere before the edit began: the card shows what happened.
          if (answer.status === 'gone' || answer.status === 'changed') {
            gone(edit)
          } else if (answer.status === 'not-editable') {
            handOff(edit)
            onSendError(QUEUED_EDIT_NOTICE_COPY.editFailed)
            close()
          }
        },
        () => undefined
      )
      return true
    },
    [client, close, enabled, gone, handOff, messages, onSendError, render, sessionId, sessionKey]
  )
  const change = useCallback(
    (text: string) => {
      const edit = active.current
      if (edit && !edit.saving) {
        edit.text = text
        render(edit)
      }
    },
    [render]
  )
  const save = useCallback(async (): Promise<boolean> => {
    const edit = active.current
    if (!edit || edit.saving || !sessionId) {
      return false
    }
    const edited = queuedMessageWithEdit(edit.body, { text: edit.text })
    if (!edited.ok) {
      return false
    }
    if (!queuedEditDirty(edit.body, edit)) {
      close()
      return true
    }
    // When Save’s reply is lost or refused, published card state proves whether its body landed.
    const desired = agentSessionSendBodyFingerprint(sessionId, edited.body)
    const standing = () => queuedEditStanding(latest.current, sessionId, edit.messageId, desired)
    edit.saving = true
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: edit.fingerprint, text: edit.text },
      () => isOpen(active, edit) && standing() === 'differs'
    )
    // A reply during a chat switch belongs to the outgoing chat.
    if (!isOpen(active, edit) || clientRef.current.sessionKey !== edit.scope) {
      return false
    }
    edit.saving = false
    if (result.status === 'accepted') {
      const { status } = result.value
      if (status === 'updated' || status === 'unchanged') {
        close()
        onActionResolved?.()
        return true
      }
      if (status === 'gone') {
        gone(edit)
        return false
      }
      if (status === 'changed') {
        // Preserve typing after a competing edit, then reopen on the newer text.
        onSendError(QUEUED_EDIT_NOTICE_COPY[queuedEditChangedNotice(handOff(edit), false)])
        reopen.current = { scope: edit.scope, messageId: edit.messageId, stale: edit.fingerprint }
        close()
        return false
      }
      onSendError(QUEUED_EDIT_NOTICE_COPY.editFailed)
      render(edit)
      return false
    }
    const settled = standing()
    if (settled === 'sent' || settled === 'holds') {
      close()
      onActionResolved?.()
      return true
    }
    if (settled === 'gone') {
      gone(edit)
      return false
    }
    render(edit)
    return false
  }, [close, gone, handOff, mutate, onActionResolved, onSendError, render, sessionId])

  // Let in-flight Save decide delivery races; otherwise reconcile departures, but never infer them from an unloaded list.
  useEffect(() => {
    const edit = active.current
    if (edit && edit.scope === sessionKey && !edit.saving && messages !== null && sessionId) {
      const typed = queuedMessageWithEdit(edit.body, { text: edit.text })
      const desired = typed.ok ? agentSessionSendBodyFingerprint(sessionId, typed.body) : null
      const standing = queuedEditStanding(
        { messages, cards, submissions },
        sessionId,
        edit.messageId,
        desired
      )
      // `holds`: the card already holds what is typed, as after a Save whose answer was lost.
      if (standing === 'sent' || (standing === 'holds' && desired !== edit.fingerprint)) {
        close()
      } else if (standing === 'gone') {
        gone(edit)
      }
    }
    const pending = reopen.current
    if (!pending || active.current || messages === null || !sessionId) {
      return
    }
    const listed = messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== sessionKey || !listed || !queuedCardOnScreen(cards, pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, listed.body) !== pending.stale) {
      void begin(pending.messageId)
    }
  }, [begin, cards, close, gone, messages, sessionId, sessionKey, shown, submissions])

  const editor: MobileQueuedMessageInlineEditor | undefined =
    shown?.scope === sessionKey
      ? {
          messageId: shown.messageId,
          text: shown.text,
          saving: shown.saving,
          canSave: queuedMessageWithEdit(shown.body, { text: shown.text }).ok,
          change,
          save,
          cancel: () => {
            if (!active.current?.saving) {
              close()
            }
          }
        }
      : undefined
  return { begin, editor }
}

function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}
