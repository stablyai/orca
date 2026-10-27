import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSessionQueuedMessageMoveResult } from '../../../src/shared/agent-session-wire'
import type { DragReorderMove } from '../components/drag-reorder-positions'
import type { MobileQueuedMessageFeed } from './mobile-structured-queued-message-feed'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

export function useMobileQueuedMessageComposerActions(args: {
  sessionKey: string
  sessionId: string | null
  messages: MobileQueuedMessageFeed
  reorderCapable: boolean
  enabled: boolean
  mutate: MobileStructuredAgentMutate
  onSendError: (message: string) => void
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
  const move = useCallback(
    async (move: DragReorderMove): Promise<boolean> => {
      if (!args.enabled || !messages) {
        return false
      }
      const source = messages.find((message) => message.messageId === move.movedId)
      const remaining = messages.filter((message) => message !== source)
      const anchor = 'beforeId' in move ? move.beforeId : move.afterId
      const at = remaining.findIndex((message) => message.messageId === anchor)
      if (!source || at === -1) {
        return false
      }
      remaining.splice(at + ('afterId' in move ? 1 : 0), 0, source)
      setPreview({
        scope: sessionKey,
        source: messages,
        messages: remaining
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
    move: args.reorderCapable && args.enabled ? move : undefined
  }
}
