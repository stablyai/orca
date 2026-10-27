import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import {
  queuedMessageEditableText,
  queuedMessageWithEdit
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

type Edit = {
  scope: string
  messageId: string
  body: AgentSessionQueuedMessage['body']
  text: string
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
  mutate: MobileStructuredAgentMutate
  appendComposerText: ((text: string) => boolean) | undefined
  onSendError: (text: string) => void
  onActionResolved?: () => void
}) {
  const { sessionKey, sessionId, client, enabled, mutate, onSendError, onActionResolved } = args
  const clientRef = useRef({ sessionKey, client })
  useLayoutEffect(() => {
    clientRef.current = { sessionKey, client }
  }, [client, sessionKey])
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

  useEffect(() => {
    return () => {
      const edit = active.current
      active.current = null
      reopen.current = null
      setShown(null)
      edit?.lease.end()
    }
  }, [sessionKey, args.chatActive])

  const begin = useCallback(
    async (messageId: string): Promise<boolean> => {
      reopen.current = null
      if (active.current || !enabled || !client || !sessionId) {
        return false
      }
      const message = args.messages?.find((entry) => entry.messageId === messageId)
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
          if (answer.status === 'gone') {
            close()
          } else if (answer.status === 'changed') {
            onSendError('This message changed while you were editing.')
          } else if (answer.status === 'not-editable') {
            onSendError("This message can't be edited.")
          }
        },
        () => undefined
      )
      return true
    },
    [args.messages, client, close, enabled, onSendError, render, sessionId, sessionKey]
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
    if (
      !edit ||
      edit.saving ||
      !sessionId ||
      !queuedMessageWithEdit(edit.body, { text: edit.text }).ok
    ) {
      return false
    }
    if (edit.text === queuedMessageEditableText(edit.body)) {
      close()
      return true
    }
    edit.saving = true
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: edit.fingerprint, text: edit.text },
      () => isOpen(active, edit)
    )
    // A reply during a chat switch belongs to the outgoing chat.
    if (!isOpen(active, edit) || clientRef.current.sessionKey !== edit.scope) {
      return false
    }
    edit.saving = false
    if (result.status === 'accepted') {
      if (result.value.status === 'updated' || result.value.status === 'unchanged') {
        close()
        onActionResolved?.()
        return true
      }
      if (result.value.status === 'gone') {
        close()
        return false
      }
      // Preserve local typing in the composer before reopening a concurrently edited card.
      const typed = edit.text.trim() !== ''
      if (result.value.status === 'changed' && (!typed || args.appendComposerText?.(edit.text))) {
        onSendError(
          typed
            ? 'This message changed while you were editing. Your edit is in the chat box.'
            : 'This message changed while you were editing.'
        )
        reopen.current = { scope: edit.scope, messageId: edit.messageId, stale: edit.fingerprint }
        close()
        return false
      }
      onSendError(
        result.value.status === 'changed'
          ? 'This message changed while you were editing.'
          : "This message can't be edited."
      )
    }
    render(edit)
    return false
  }, [args.appendComposerText, close, mutate, onActionResolved, onSendError, render, sessionId])

  useEffect(() => {
    const edit = active.current
    const listed = (messageId: string): boolean =>
      args.messages?.some((message) => message.messageId === messageId) === true &&
      args.cards.some((card) => card.messageId === messageId)
    if (edit && edit.scope === sessionKey && args.messages !== null && !listed(edit.messageId)) {
      close()
    }
    const pending = reopen.current
    if (!pending || active.current || args.messages === null || !sessionId) {
      return
    }
    const message = args.messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== sessionKey || !message || !listed(pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, message.body) !== pending.stale) {
      void begin(pending.messageId)
    }
  }, [args.cards, args.messages, begin, close, sessionId, sessionKey, shown])

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
