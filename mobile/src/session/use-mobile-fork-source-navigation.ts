import { useCallback, useEffect, useRef } from 'react'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { structuredSessionOpenFailure } from '../../../src/shared/open-structured-agent-session'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionOpenMessage } from './mobile-structured-session-open-message'
import { openMobileStructuredSession } from './open-mobile-structured-session'

/** Opens the chat a fork came from; a fork and its source share a workspace and host. */
export function useMobileForkSourceNavigation(
  client: RpcClient | null,
  navigate: (worktreeId: string, paneKey: string) => void,
  showToast: (message: string, duration?: number) => void,
  worktreeId: string
): ((sourceSessionId: string) => void) | undefined {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const open = useCallback(
    (sourceSessionId: string) => {
      if (!client) {
        return
      }
      const fail = (reason: Parameters<typeof mobileStructuredSessionOpenMessage>[0]) => {
        if (mounted.current) {
          showToast(mobileStructuredSessionOpenMessage(reason), 3000)
        }
      }
      void openMobileStructuredSession({
        client,
        current: () => mounted.current,
        source: {
          kind: 'history',
          structuredSession: { sessionId: sourceSessionId, workspaceId: worktreeId }
        }
      })
        .then((result) => {
          if (!mounted.current) {
            return
          }
          if (result.kind === 'opened') {
            navigate(
              result.target.worktreeId,
              structuredAgentSessionPaneKey(result.tab.id, result.target.sessionId)
            )
          } else if (result.kind === 'failed') {
            fail(result.failure.reason)
          }
        })
        .catch((error: unknown) => fail(structuredSessionOpenFailure(error).reason))
    },
    [client, navigate, showToast, worktreeId]
  )
  return client ? open : undefined
}
