import { useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import type { AgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import { structuredAgentSessionPaneKey } from '../../../src/shared/structured-agent-session-projection'
import {
  structuredSessionOpenFailure,
  structuredSessionOpenMessage
} from '../../../src/shared/open-structured-agent-session'
import type { RpcClient } from '../transport/rpc-client'
import { openMobileStructuredSession } from './open-mobile-structured-session'
import { openMobileAgentMessageTerminal } from './mobile-agent-message-terminal'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileAgentMessageNavigation(
  client: RpcClient | null,
  navigate: (worktreeId: string, paneKey: string) => void,
  sourceKey: string,
  showToast: (message: string, duration?: number) => void,
  {
    worktreeId,
    activeSessionTabIdRef,
    selectedSessionTabIdRef,
    sessionTabsRef,
    pendingSelectionRef
  }: Pick<
    MobileSessionKeyboardStateModel,
    | 'worktreeId'
    | 'activeSessionTabIdRef'
    | 'selectedSessionTabIdRef'
    | 'sessionTabsRef'
    | 'pendingSelectionRef'
  >
) {
  const scope = useRef<{ active: boolean; attempt?: { key: string } }>({ active: false })
  useFocusEffect(
    useCallback(() => {
      const visit = { active: true }
      scope.current = visit
      return () => {
        visit.active = false
      }
    }, [client, navigate, sourceKey])
  )
  return useCallback(
    (from: AgentMessageSource, sender: AgentMessageSource['senders'][number]) => {
      const visit = scope.current
      if (!visit.active) {
        return
      }
      const generation = client?.getGeneration?.()
      const messageIds =
        from.orchestration?.message === 'mail-notice'
          ? from.orchestration.messages
              .filter((message) => message.from === sender.party.address)
              .map((message) => message.messageId)
          : []
      const key = JSON.stringify([generation, sender.party, messageIds])
      if (visit.attempt?.key === key) {
        return
      }
      const sourceId = activeSessionTabIdRef.current
      if (
        !pendingSelectionRef.current &&
        sourceId &&
        sessionTabsRef.current.some((tab) => tab.id === sourceId)
      ) {
        selectedSessionTabIdRef.current = sourceId
      }
      const selected = selectedSessionTabIdRef.current
      const pending = pendingSelectionRef.current
      const attempt = { key }
      visit.attempt = attempt
      const current = () =>
        visit.active &&
        scope.current === visit &&
        visit.attempt === attempt &&
        client?.getGeneration?.() === generation &&
        selectedSessionTabIdRef.current === selected &&
        pendingSelectionRef.current === pending
      const failure = (reason: Parameters<typeof structuredSessionOpenMessage>[0]) => {
        if (current()) {
          showToast(structuredSessionOpenMessage(reason, sender.name ?? ''), 3000)
        }
      }
      const deadline = Date.now() + 15_000
      void (async () => {
        if (!client || client.getState() !== 'connected') {
          failure('unreachable')
          return
        }
        const known = sessionTabsRef.current.find(
          (tab) => tab.type === 'agent-session' && tab.sessionId === sender.party.orcaSessionId
        )
        // TODO(#36315): pass known terminal fallback through the shared sender contract.
        const result = await openMobileStructuredSession({
          client,
          current,
          source: {
            kind: 'sender',
            address: sender.party.address,
            messageIds,
            ...(known?.type === 'agent-session'
              ? {
                  fallback: { sessionId: known.sessionId, worktreeId, agent: known.agent }
                }
              : {})
          }
        })
        if (!current()) {
          return
        }
        if (result.kind === 'opened') {
          navigate(
            result.target.worktreeId,
            structuredAgentSessionPaneKey(result.tab.id, result.target.sessionId)
          )
        } else if (result.kind === 'terminal') {
          const destination = await openMobileAgentMessageTerminal(
            client,
            result.handle,
            current,
            deadline
          )
          if (current()) {
            navigate(destination.worktreeId, destination.paneKey)
          }
        } else if (result.kind === 'failed') {
          failure(result.failure.reason)
        }
      })()
        .catch((error) => failure(structuredSessionOpenFailure(error).reason))
        .finally(() => {
          if (visit.attempt === attempt) {
            visit.attempt = undefined
          }
        })
    },
    [
      client,
      navigate,
      showToast,
      worktreeId,
      activeSessionTabIdRef,
      selectedSessionTabIdRef,
      sessionTabsRef,
      pendingSelectionRef
    ]
  )
}
