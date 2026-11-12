import { useCallback, useMemo, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_SESSION_SIGNED_OUT_RETRY_RUNTIME_CAPABILITY,
  latestNativeChatSignedOutSend,
  nativeChatSignedOutSendCard
} from '../../../../../src/shared/native-chat/native-chat-signed-out-retry'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import { useRouteRelaysCapability } from '../../../worktree/workspace-server-context'
import type { StructuredAgentSessionHostSupport } from '../agent-session/mobile-structured-agent-session-host-support'

/** Retry under the row of a send refused for want of a login; `messageId` is that row's id. */
export type MobileStructuredSignedOutRetry = { messageId: string; retry: () => void }

// Desktop's Retry on the same send; the host rechecks it is still the latest send before re-sending.
export function useMobileStructuredSignedOutRetry(input: {
  client: RpcClient | null
  sessionId: string | null
  hostSupport: StructuredAgentSessionHostSupport | null
  submissions: readonly AgentJournalSubmission[]
}): MobileStructuredSignedOutRetry | null {
  const { client, sessionId, submissions } = input
  // An older paired desktop relaying to a newer server refuses the method from a phone.
  const relayed = useRouteRelaysCapability(AGENT_SESSION_SIGNED_OUT_RETRY_RUNTIME_CAPABILITY)
  const refused = latestNativeChatSignedOutSend(submissions)
  // A card holds the text with its own Send, which already retries it.
  const offered =
    input.hostSupport?.signedOutRetry && relayed && refused && !nativeChatSignedOutSendCard(refused)
      ? refused.clientMessageId
      : null
  // Hidden from the tap until the host answers; the journal then shows the re-sent message.
  const [asked, setAsked] = useState<string | null>(null)
  const retry = useCallback(() => {
    if (offered === null || !client || !sessionId) {
      return
    }
    setAsked(offered)
    void callAgentSession<{ outcome?: string }>(client, 'agentSession.retrySignedOutSend', {
      sessionId,
      clientMessageId: offered
    })
      .catch(() => null)
      .then((answer) => {
        if (answer?.outcome !== 'sent') {
          setAsked((current) => (current === offered ? null : current))
        }
      })
  }, [offered, client, sessionId])
  return useMemo(
    () =>
      offered === null || asked === offered
        ? null
        : { messageId: agentJournalSubmissionKey(offered), retry },
    [offered, asked, retry]
  )
}
