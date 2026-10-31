import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../src/shared/agent-session-thread-goal-wire'
import { agentSessionWriteNoticeParts } from '../../../src/shared/agent-session-refusal-notice'
import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

export type MobileThreadGoalControls = {
  pending: boolean
  disabled: boolean
  change: (change: AgentSessionThreadGoalChange) => Promise<boolean>
}

export function useMobileStructuredThreadGoalControls(args: {
  sessionKey: string
  client: RpcClient | null
  fence: number | null
  enabled: boolean
  supported: boolean
  mutate: MobileStructuredAgentMutate
  reread: () => void
  onSendError: (message: string) => void
}): MobileThreadGoalControls | undefined {
  const { sessionKey, client, fence, enabled, supported, mutate, reread, onSendError } = args
  const generation = useSyncExternalStore(client?.onStateChange ?? (() => () => {}), () =>
    client?.getGeneration?.()
  )
  const context = useMemo(
    () => ({ live: false, pending: false }),
    [sessionKey, client, generation, fence, enabled, supported]
  )
  useLayoutEffect(() => {
    context.live = true
    return () => {
      context.live = false
    }
  }, [context])
  const [pendingContext, setPendingContext] = useState<typeof context | null>(null)
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      const isCurrent = () => context.live && client?.getGeneration?.() === generation
      if (!isCurrent() || context.pending || !enabled || !supported || fence === null) {
        return false
      }
      context.pending = true
      setPendingContext(context)
      try {
        const result = await mutate<AgentSessionThreadGoalResult>(
          'agentSession.threadGoal',
          'agentSession.threadGoal',
          { change: next },
          isCurrent
        )
        if (!isCurrent()) {
          return false
        }
        if (result.status === 'unknown') {
          onSendError(
            mobileAgentSessionWriteNoticeText(
              agentSessionWriteNoticeParts({ kind: 'unconfirmed' }, 'goal')
            )
          )
        }
        if (result.status === 'accepted' && result.sameFence) {
          reread()
          return true
        }
        return false
      } finally {
        context.pending = false
        if (context.live) {
          setPendingContext(null)
        }
      }
    },
    [context, client, generation, enabled, supported, fence, mutate, reread, onSendError]
  )
  return supported ? { pending: pendingContext === context, disabled: !enabled, change } : undefined
}
