import type { QueuedEditLeaseLoss } from '../../../src/shared/queued-message-edit-lease'
import { createMobileQueuedEdit } from './mobile-queued-message-edit-open'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import {
  mobileQueuedEditValueKey,
  snapshotMobileQueuedEditInputs
} from './mobile-queued-message-edit-value'
import { settleMobileQueuedEdit } from './mobile-queued-message-edit-outcome'
import { queuedEditPublicationKey } from '../../../src/shared/queued-message-edit-publication'
import { startMobileQueuedEditLease } from './mobile-queued-message-edit-lease'
import {
  useMobileNativeChatDraftInputs,
  readMobileNativeChatDraftInputs,
  mobileNativeChatDraftDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  closeMobileQueuedEditDraft,
  mobileQueuedEditSaving,
  insertMobileQueuedEditDictation,
  serializeMobileQueuedEdit,
  mobileQueuedEditSaveHeld,
  removeMobileQueuedEditImage,
  type MobileQueuedEditDraft as Edit,
  type MobileStructuredQueuedEditArgs,
  type MobileQueuedMessageInlineEditor
} from './mobile-queued-message-edit-draft'
export type { MobileQueuedMessageInlineEditor } from './mobile-queued-message-edit-draft'

export function useMobileStructuredQueuedEdit(args: MobileStructuredQueuedEditArgs) {
  const { sessionKey, sessionId, client, mutate, onSendError, onActionResolved } = args
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  const latest = useRef(args)
  useLayoutEffect(() => {
    latest.current = args
    const edit = active.current
    if (edit?.scope === args.sessionKey) {
      edit.published = {
        messages: args.messages,
        submissions: args.submissions ?? [],
        cards: args.cards
      }
    }
  })
  useMobileNativeChatDraftInputs(shown?.scopeKey ?? null)
  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(
    (edit: Edit, handBack = false) => {
      closeMobileQueuedEditDraft(edit, handBack, latest.current.onQueuedEditNotice)
      if (active.current === edit) {
        render(null)
      }
    },
    [render]
  )

  const receiveLoss = useCallback(
    (edit: Edit, loss: QueuedEditLeaseLoss, observe: (edit: Edit) => unknown) => {
      if (edit.closed || edit.lease !== loss.lease) {
        return
      }
      edit.leaseLoss = loss
      observe(edit)
    },
    []
  )
  const acquire = useCallback(
    (edit: Edit, observe: (edit: Edit) => unknown) => {
      edit.lease.end()
      edit.leaseLoss = undefined
      edit.lease = startMobileQueuedEditLease({
        getClient: () =>
          latest.current.sessionKey === edit.scope ? latest.current.client : edit.client,
        sessionId: edit.sessionId,
        messageId: edit.messageId,
        expectedBodyFingerprint: edit.fingerprint,
        onLost: (loss) => receiveLoss(edit, loss, observe)
      })
    },
    [receiveLoss]
  )

  const settle = useCallback(
    function settleResult(
      edit: Edit,
      attempt = edit.attempt,
      result?: Awaited<ReturnType<typeof mutate<AgentSessionQueuedMessageUpdateResult>>>
    ) {
      if (edit.closed || edit.attempt !== attempt || (!result && mobileQueuedEditSaving(edit))) {
        return false
      }
      const outcome = settleMobileQueuedEdit(edit, attempt, result)
      if (outcome === 'close') {
        close(edit, true)
        if (!edit.pendingClose) {
          onActionResolved?.()
        }
        return true
      }
      if (outcome === 'rebase') {
        acquire(edit, settleResult)
      } else if (outcome === 'gone' || outcome === 'changed' || edit.pendingClose) {
        // A restored seed is still intent if an earlier write remains uncertain or a rival changed it.
        edit.uncertain ||= outcome === 'changed'
        close(edit, true)
        return false
      } else if (outcome === 'refused' && result?.status === 'accepted') {
        onSendError("This message can't be edited.")
      }
      if (active.current === edit) {
        render(edit)
      }
      return false
    },
    [acquire, close, onActionResolved, onSendError, render]
  )

  useEffect(
    () => () => {
      const edit = active.current
      if (!edit) {
        return
      }
      // A submitted snapshot owns its reply even across navigation; no publication duplicates it.
      if (mobileQueuedEditSaving(edit)) {
        edit.pendingClose = true
        active.current = null
        return
      }
      close(edit, true)
    },
    [sessionKey, args.chatActive, close]
  )

  const begin = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (active.current) {
        return false
      }
      const edit = createMobileQueuedEdit(
        { ...latest.current, sessionKey, sessionId, client },
        messageId,
        () => (latest.current.sessionKey === sessionKey ? latest.current.client : client),
        (edit, loss) => receiveLoss(edit, loss, settle)
      )
      if (!edit) {
        return false
      }
      render(edit)
      return true
    },
    [client, receiveLoss, render, sessionId, sessionKey, settle]
  )

  const save = useCallback(async (): Promise<boolean> => {
    const edit = active.current
    if (!edit || mobileQueuedEditSaving(edit) || !sessionId) {
      return false
    }
    if (mobileQueuedEditSaveHeld(edit, args.imagesCapable)) {
      return false
    }
    const fields = serializeMobileQueuedEdit(edit, args.imagesCapable, args.skillsCapable)
    const desired = queuedMessageWithEdit(edit.body, fields)
    if (!desired.ok) {
      return false
    }
    if (
      !edit.uncertain &&
      !edit.attempt &&
      mobileQueuedEditValueKey(edit.text, readMobileNativeChatDraftInputs(edit.scopeKey)) ===
        edit.baseKey
    ) {
      close(edit, true)
      onActionResolved?.()
      return true
    }
    const attempt = {
      phase: 'pending' as const,
      expected: edit.fingerprint,
      fingerprint: agentSessionSendBodyFingerprint(sessionId, desired.body),
      body: desired.body,
      text: edit.text,
      inputs: snapshotMobileQueuedEditInputs(readMobileNativeChatDraftInputs(edit.scopeKey)),
      key: mobileQueuedEditValueKey(edit.text, readMobileNativeChatDraftInputs(edit.scopeKey))
    }
    edit.attempt = attempt
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: attempt.expected, ...fields },
      () => !edit.closed && !edit.pendingClose && edit.leaseLoss?.lease !== edit.lease
    )
    return settle(edit, attempt, result)
  }, [
    args.imagesCapable,
    args.skillsCapable,
    close,
    mutate,
    onActionResolved,
    render,
    sessionId,
    settle
  ])

  const publication = useMemo(
    () =>
      queuedEditPublicationKey(
        { messages: args.messages, cards: args.cards, submissions: args.submissions },
        sessionId ?? '',
        shown?.messageId
      ),
    [args.messages, args.cards, args.submissions, sessionId, shown?.messageId]
  )
  const reconcile = useEffectEvent(() => {
    const edit = active.current
    if (
      !edit ||
      mobileQueuedEditSaving(edit) ||
      edit.scope !== sessionKey ||
      args.messages === null
    ) {
      return
    }
    const onScreen = args.cards.some(({ messageId }) => messageId === edit.messageId)
    if (!onScreen && !edit.attempt) {
      close(edit, true)
    } else {
      settle(edit)
    }
  })
  useEffect(() => {
    reconcile()
  }, [publication, sessionKey])

  const editing = active.current
  const inputDestination = editing ? mobileNativeChatDraftDestination(editing.scopeKey) : null
  const editor: MobileQueuedMessageInlineEditor | undefined =
    shown?.scope === sessionKey
      ? {
          messageId: shown.messageId,
          scopeKey: shown.scopeKey,
          client: shown.client,
          sessionId: shown.sessionId,
          imagesCapable: args.imagesCapable === true,
          text: shown.text,
          saving: mobileQueuedEditSaving(shown),
          canSave:
            !mobileQueuedEditSaveHeld(shown, args.imagesCapable) &&
            queuedMessageWithEdit(
              shown.body,
              serializeMobileQueuedEdit(shown, args.imagesCapable, args.skillsCapable)
            ).ok,
          insertDictation: (text) => {
            const inserted =
              editing &&
              inputDestination &&
              insertMobileQueuedEditDictation(editing, inputDestination, text)
            if (inserted && active.current === editing) {
              render(editing)
            }
            return Boolean(inserted)
          },
          change: (text) => {
            const edit = active.current
            if (edit && !mobileQueuedEditSaving(edit)) {
              edit.text = text
              render(edit)
            }
          },
          removeImage: (id) => {
            const edit = active.current
            if (!edit || mobileQueuedEditSaving(edit) || !args.imagesCapable) {
              return
            }
            removeMobileQueuedEditImage(edit, id)
            render(edit)
          },
          save,
          cancel: () => {
            if (active.current) {
              close(active.current)
            }
          }
        }
      : undefined
  return { begin, editor }
}
