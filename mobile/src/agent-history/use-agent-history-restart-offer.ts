import { useCallback, useEffect, useState } from 'react'
import * as z from 'zod'
import { AGENT_SESSION_PHONE_RESTART_RESUME_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { salvagingArray } from '../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useRouteRelaysCapability } from '../worktree/execution-hosts/workspace-server-context'
import { agentHistoryCapabilityRead } from './mobile-agent-history-operations'

// Only the count is shown; rows stay opaque so a newer host's candidate shape still counts.
const restartOfferSchema = z.looseObject({ sessions: salvagingArray(z.unknown()) })

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
    read: rpcResultVariant('agent-history-restart-continue', restartOfferSchema.partial())
  })
)

export type AgentHistoryRestartOffer = {
  /** Interrupted chats the host offers to resume; 0 hides the banner. */
  count: number
  resuming: boolean
  failed: boolean
  resumeAll: () => void
  dismiss: () => void
}

/** Desktop's resume-after-restart offer, read once per visit on hosts that let a phone act on it. */
export function useAgentHistoryRestartOffer(
  client: RpcClient | null,
  connected: boolean
): AgentHistoryRestartOffer {
  const relayed = useRouteRelaysCapability(AGENT_SESSION_PHONE_RESTART_RESUME_RUNTIME_CAPABILITY)
  const [count, setCount] = useState(0)
  const [resuming, setResuming] = useState(false)
  const [failed, setFailed] = useState(false)
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
        const offer = restartOfferRead.interpret(await restartOfferRead.request(client))
        if (!cancelled && offer.accepted) {
          setCount(offer.value.sessions.length)
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
    setFailed(false)
    void (async () => {
      try {
        const answer = restartContinueRun.interpret(await restartContinueRun.request(client, {}))
        if (!answer.accepted) {
          setFailed(true)
          return
        }
        setCount(answer.value.sessions?.length ?? 0)
      } catch {
        setFailed(true)
      } finally {
        setResuming(false)
      }
    })()
  }, [client, resuming])

  const dismiss = useCallback(() => setDismissed(true), [])

  return { count: dismissed ? 0 : count, resuming, failed, resumeAll, dismiss }
}
