import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessageMoveResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import type { DragReorderMove } from '../components/drag-reorder-positions'
import { mobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import type { MobileQueuedMessageCopy } from './mobile-native-chat-queued-extraction'
import type { MobileQueuedMessageFeed } from './mobile-structured-queued-message-feed'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

export function useMobileQueuedMessageComposerActions(args: {
  sessionKey: string
  sessionId: string | null
  messages: MobileQueuedMessageFeed
  copyCapable: boolean
  reorderCapable: boolean
  queuedImageCards: boolean
  enabled: boolean
  promptPending: boolean
  copyQueuedMessage?: MobileQueuedMessageCopy
  mutate: MobileStructuredAgentMutate
  onSendError: (message: string) => void
  onActionResolved?: () => void
}) {
  const { messages, sessionKey, mutate } = args
  const currentScope = useRef<string | null>(sessionKey)
  useLayoutEffect(() => {
    currentScope.current = sessionKey
    return () => {
      currentScope.current = null
    }
  }, [sessionKey])
  const [preview, setPreview] = useState<{
    scope: string
    source: MobileQueuedMessageFeed
    messages: MobileQueuedMessageFeed
  } | null>(null)
  const copyEdit = useCallback(
    async (messageId: string, onCopied?: () => void) => {
      if (!args.enabled || args.promptPending || !args.sessionId || !args.copyQueuedMessage) {
        return false
      }
      const message = messages?.find((entry) => entry.messageId === messageId)
      if (
        !message ||
        (message.body.blocks.some((block) => block.type === 'image-ref') && !args.queuedImageCards)
      ) {
        return false
      }
      const expectedBodyFingerprint = agentSessionSendBodyFingerprint(args.sessionId, message.body)
      let copied
      try {
        copied = await args.copyQueuedMessage(message)
        if (!copied) {
          throw new Error('Draft copy was not acknowledged')
        }
      } catch {
        if (currentScope.current === sessionKey) {
          args.onSendError("Couldn't save this message to your draft. It is still queued.")
        }
        return false
      }
      if (currentScope.current === sessionKey) {
        onCopied?.()
      }
      if (!copied.valid()) {
        if (currentScope.current === sessionKey) {
          args.onSendError("Couldn't save this message to your draft. It is still queued.")
        }
        return false
      }
      const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
        'agentSession.queuedMessageDelete',
        'agentSession.queuedMessageDelete',
        { messageId, expectedBodyFingerprint },
        () => false
      )
      if (result.status !== 'accepted' || !result.value.deleted) {
        if (currentScope.current === sessionKey) {
          args.onSendError(
            result.status === 'accepted' &&
              !result.value.deleted &&
              result.value.disposition === 'dispatched'
              ? 'Already sent — your message is still in the composer.'
              : "Couldn't remove this queued message. Your copy is in the composer."
          )
        }
        return false
      }
      if (currentScope.current === sessionKey) {
        args.onActionResolved?.()
      }
      return true
    },
    [args, messages, mutate, sessionKey]
  )
  const move = useCallback(
    async (move: DragReorderMove): Promise<boolean> => {
      if (!args.enabled || !messages) {
        return false
      }
      const user = messages.filter((message) => message.body.from === undefined)
      const source = user.find((message) => message.messageId === move.movedId)
      const remaining = user.filter((message) => message !== source)
      const anchor = 'beforeId' in move ? move.beforeId : move.afterId
      const at = remaining.findIndex((message) => message.messageId === anchor)
      if (!source || at === -1) {
        return false
      }
      remaining.splice(at + ('afterId' in move ? 1 : 0), 0, source)
      let index = 0
      setPreview({
        scope: sessionKey,
        source: messages,
        messages: messages.map((message) =>
          message.body.from === undefined ? remaining[index++]! : message
        )
      })
      const result = await mutate<AgentSessionQueuedMessageMoveResult>(
        'agentSession.queuedMessageMove',
        'agentSession.queuedMessageMove',
        {
          messageId: move.movedId,
          ...('beforeId' in move
            ? { beforeMessageId: move.beforeId }
            : { afterMessageId: move.afterId })
        },
        () => currentScope.current === sessionKey
      )
      const accepted =
        result.status === 'accepted' &&
        (result.value.status === 'moved' || result.value.status === 'unchanged')
      if (!accepted) {
        setPreview((held) => (held?.scope === sessionKey && held.source === messages ? null : held))
        if (result.status === 'accepted' && currentScope.current === sessionKey) {
          args.onSendError('This queue changed. Try moving the message again.')
        }
      }
      return accepted
    },
    [args, messages, mutate, sessionKey]
  )
  return {
    messages:
      preview?.scope === sessionKey && preview.source === messages ? preview.messages : messages,
    copyEdit: args.copyCapable && mobileChatDraftStorage() ? copyEdit : undefined,
    move: args.reorderCapable && args.enabled ? move : undefined
  }
}
