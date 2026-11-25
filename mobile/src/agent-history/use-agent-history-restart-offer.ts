import { useCallback, useEffect, useState } from 'react'
import * as z from 'zod'
import { AGENT_SESSION_PHONE_RESTART_RESUME_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { salvagingArray } from '../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useRouteRelaysCapability } from '../worktree/execution-hosts/workspace-server-context'
import { agentHistoryCapabilityRead } from './mobile-agent-history-operations'
import { AGENT_SESSION_RESTART_CONTINUE_TIMEOUT_MS } from '../../../src/shared/agent-session/lifecycle/resume/agent-session-restart-continue-timeout'

// Only counts are shown; rows stay opaque so a newer host's row shapes still count. After Resume all,
// absent lists mean the host couldn't re-read its offers, not that none are left.
const restartOfferSchema = z.looseObject({
  sessions: salvagingArray(z.unknown()).optional(),
  failed: salvagingArray(z.unknown()).optional()
})

const restartOfferRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.restart-offer',
    method: 'agentSession.restartResumable',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-history-restart-offer', restartOfferSchema)
  })
)

// No ids: the host continues every chat it still offers this client, rechecking each one.
const restartContinueRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.restart-continue-all',
    method: 'agentSession.restartContinue',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-history-restart-continue', restartOfferSchema)
  })
)

export type AgentHistoryRestartOffer = {
  /** Interrupted chats the host offers to resume; 0 hides the banner unless some failed. */
  count: number
  resuming: boolean
  /** Chats the host tried and couldn't carry on; desktop's restart dialog lists why. */
  failedCount: number
  /** The Resume all request itself didn't complete, so it can be retried. */
  requestFailed: boolean
  resumeAll: () => void
  dismiss: () => void
}

type OfferCounts = { count: number; failedCount: number }

function offerCounts(value: z.output<typeof restartOfferSchema>): OfferCounts | null {
  return value.sessions
    ? { count: value.sessions.length, failedCount: value.failed?.length ?? 0 }
    : null
}

async function readOfferCounts(client: RpcClient): Promise<OfferCounts | null> {
  const offer = restartOfferRead.interpret(await restartOfferRead.request(client))
  return offer.accepted ? offerCounts(offer.value) : null
}

/** Desktop's resume-after-restart offer, read once per visit on hosts that let a phone act on it. */
export function useAgentHistoryRestartOffer(
  client: RpcClient | null,
  connected: boolean
): AgentHistoryRestartOffer {
  const relayed = useRouteRelaysCapability(AGENT_SESSION_PHONE_RESTART_RESUME_RUNTIME_CAPABILITY)
  const [counts, setCounts] = useState<OfferCounts>({ count: 0, failedCount: 0 })
  const [resuming, setResuming] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)
  // Like closing desktop's dialog: a snooze for this visit, the host keeps the offer.
  const [dismissed, setDismissed] = useState(false)

  // Re-read on reconnect too: a Resume all cut off by a dropped socket may still have run on the host.
  useEffect(() => {
    if (!client || !connected || !relayed) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const status = agentHistoryCapabilityRead.interpret(
          await agentHistoryCapabilityRead.request(client)
        )
        if (
          cancelled ||
          !status.capabilities?.includes(AGENT_SESSION_PHONE_RESTART_RESUME_RUNTIME_CAPABILITY)
        ) {
          return
        }
        const read = await readOfferCounts(client)
        if (!cancelled && read) {
          setCounts(read)
          setRequestFailed(false)
        }
      } catch {
        // No offer is shown when the host can't be asked.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connected, relayed])

  const resumeAll = useCallback(() => {
    if (!client || !connected || resuming) {
      return
    }
    setResuming(true)
    setRequestFailed(false)
    void (async () => {
      try {
        const answer = restartContinueRun.interpret(
          await restartContinueRun.request(
            client,
            {},
            // Never queue a bulk resume to run whenever the phone next reconnects.
            { timeoutMs: AGENT_SESSION_RESTART_CONTINUE_TIMEOUT_MS, failWhenDisconnected: true }
          )
        )
        if (!answer.accepted) {
          setRequestFailed(true)
          return
        }
        const after = offerCounts(answer.value) ?? (await readOfferCounts(client))
        if (after) {
          setCounts(after)
        }
      } catch {
        setRequestFailed(true)
      } finally {
        setResuming(false)
      }
    })()
  }, [client, connected, resuming])

  const dismiss = useCallback(() => setDismissed(true), [])

  return dismissed
    ? { count: 0, resuming, failedCount: 0, requestFailed: false, resumeAll, dismiss }
    : { ...counts, resuming, requestFailed, resumeAll, dismiss }
}
