import { useCallback, useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { latestNativeChatOrcaStopCut } from '../../../src/shared/native-chat/native-chat-orca-stop-cut'
import {
  failNativeChatInterruptedContinue,
  nativeChatInterruptedContinueState,
  NO_NATIVE_CHAT_INTERRUPTED_CONTINUE_ATTEMPT,
  requestNativeChatInterruptedContinue
} from '../../../src/shared/native-chat/native-chat-interrupted-continue'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { useRouteRelaysCapability } from '../transport/workspace-server-context'
import { AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-continue-interrupted-capability'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

export type MobileStructuredInterruptedContinue = {
  continueAvailable: boolean
  offeredTurnItemId: string | null
  continueNow: () => void
  failed: boolean
  dismissFailure: () => void
}

// Desktop's Continue on an Orca-stopped turn; the host rechecks the cut before it sends anything.
export function useMobileStructuredInterruptedContinue(
  input: {
    client: RpcClient | null
    sessionId: string | null
    /** Separates sessions so a late answer cannot mark another chat's cut. */
    sessionKey: string
    hostSupport: StructuredAgentSessionHostSupport | null
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  /** Also true while the host may take no turn: Continue starts one. */
  isWorking: boolean
): MobileStructuredInterruptedContinue {
  const { client, sessionId, sessionKey, items, submissions } = input
  const [held, setHeld] = useState({
    sessionKey,
    attempt: NO_NATIVE_CHAT_INTERRUPTED_CONTINUE_ATTEMPT
  })
  const attempt =
    held.sessionKey === sessionKey ? held.attempt : NO_NATIVE_CHAT_INTERRUPTED_CONTINUE_ATTEMPT
  // An older paired desktop relaying to a newer server refuses the method from a phone.
  const relayed = useRouteRelaysCapability(
    AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
  )
  const cut = useMemo(() => latestNativeChatOrcaStopCut(items, submissions), [items, submissions])
  const { continueAvailable, offeredTurnItemId, failed } = nativeChatInterruptedContinueState({
    capability: !input.hostSupport
      ? 'unknown'
      : input.hostSupport.continueInterrupted && relayed
        ? 'supported'
        : 'unsupported',
    cut,
    isWorking,
    resuming: false,
    attempt
  })
  const continueNow = useCallback(() => {
    if (offeredTurnItemId === null || !client || !sessionId) {
      return
    }
    const turnItemId = offeredTurnItemId
    setHeld({ sessionKey, attempt: { asked: turnItemId, failedOn: null } })
    void requestNativeChatInterruptedContinue(
      (method, params) => callAgentSession<{ outcome?: string }>(client, method, params),
      sessionId,
      turnItemId
    ).then((accepted) => {
      if (!accepted) {
        setHeld((current) =>
          current.sessionKey === sessionKey
            ? {
                sessionKey,
                attempt: failNativeChatInterruptedContinue(current.attempt, turnItemId)
              }
            : current
        )
      }
    })
  }, [offeredTurnItemId, client, sessionId, sessionKey])
  const dismissFailure = useCallback(() => {
    setHeld((current) =>
      current.sessionKey === sessionKey
        ? { sessionKey, attempt: { ...current.attempt, failedOn: null } }
        : current
    )
  }, [sessionKey])
  return { continueAvailable, offeredTurnItemId, continueNow, failed, dismissFailure }
}
