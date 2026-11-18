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

// Only counts are shown; rows stay opaque so a newer host's row shapes still count.
const restartOfferSchema = z.looseObject({ sessions: salvagingArray(z.unknown()) })
// Absent lists mean the host couldn't re-read its offers after acting, not that none are left.
const restartContinueSchema = z.looseObject({
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
    read: rpcResultVariant('agent-history-restart-continue', restartContinueSchema)
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

async function readOfferCount(client: RpcClient): Promise<number | null> {
  const offer = restartOfferRead.interpret(await restartOfferRead.request(client))
  return offer.accepted ? offer.value.sessions.length : null
}

/** Desktop's resume-after-restart offer, read once per visit on hosts that let a phone act on it. */
export function useAgentHistoryRestartOffer(
  client: RpcClient | null,
  connected: boolean
): AgentHistoryRestartOffer {
  const relayed = useRouteRelaysCapability(AGENT_SESSION_PHONE_RESTART_RESUME_RUNTIME_CAPABILITY)
  const [count, setCount] = useState(0)
  const [resuming, setResuming] = useState(false)
  const [failedCount, setFailedCount] = useState(0)
  const [requestFailed, setRequestFailed] = useState(false)
  // Like closing desktop's dialog: a snooze for this visit, the host keeps the offer.
  const [dismissed, setDismissed] = useState(false)

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
        const offered = await readOfferCount(client)
        if (!cancelled && offered !== null) {
          setCount(offered)
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
    if (!client || resuming) {
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
            { timeoutMs: AGENT_SESSION_RESTART_CONTINUE_TIMEOUT_MS }
          )
        )
        if (!answer.accepted) {
          setRequestFailed(true)
          return
        }
        setFailedCount(answer.value.failed?.length ?? 0)
        const remaining = answer.value.sessions?.length ?? (await readOfferCount(client))
        if (remaining !== null) {
          setCount(remaining)
        }
      } catch {
        setRequestFailed(true)
      } finally {
        setResuming(false)
      }
    })()
  }, [client, resuming])

  const dismiss = useCallback(() => setDismissed(true), [])

  return dismissed
    ? { count: 0, resuming, failedCount: 0, requestFailed: false, resumeAll, dismiss }
    : { count, resuming, failedCount, requestFailed, resumeAll, dismiss }
}
