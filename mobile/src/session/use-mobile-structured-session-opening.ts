import { hostRouteWithNotice } from '../host-route-notice'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import {
  openMobileStructuredSession,
  mobileStructuredSessionHref
} from './open-mobile-structured-session'
import type { StructuredSessionOpenSource } from '../../../src/shared/open-structured-agent-session'
import { mobileStructuredSessionOpenMessage } from './mobile-structured-session-open-message'
import { isStructuredAgentId } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileStructuredSessionOpening(
  scope: Pick<
    MobileSessionKeyboardStateModel & ReturnType<typeof useMobileSessionTabSwitching>,
    | 'hostId'
    | 'worktreeId'
    | 'client'
    | 'connState'
    | 'showToast'
    | 'switchSessionTab'
    | 'activeSessionTabIdRef'
    | 'selectedSessionTabIdRef'
    | 'pendingSelectionRef'
    | 'sessionTabsRef'
  >
) {
  const executionHost = useWorkspaceExecutionHost()
  const router = useWorkspaceRouteHandoff()
  const { hostId, worktreeId, client, connState, showToast, switchSessionTab } = scope
  const generation = client?.getGeneration?.()
  const owner = useMemo(
    () => ({ hostId, executionHost, worktreeId, client, connState, generation }),
    [hostId, executionHost, worktreeId, client, connState, generation]
  )
  const live = useRef<typeof owner | null>(owner)
  const attempt = useRef(0)
  useLayoutEffect(() => {
    live.current = owner
    return () => {
      live.current = null
      attempt.current++
    }
  }, [owner])
  return useCallback(
    async (source: StructuredSessionOpenSource) => {
      const ticket = ++attempt.current
      const sourceId = scope.activeSessionTabIdRef.current
      if (sourceId && scope.sessionTabsRef.current.some((tab) => tab.id === sourceId)) {
        scope.selectedSessionTabIdRef.current = sourceId
      }
      const selected = scope.selectedSessionTabIdRef.current
      const pending = scope.pendingSelectionRef.current
      const current = () =>
        live.current === owner &&
        ticket === attempt.current &&
        scope.pendingSelectionRef.current === pending &&
        scope.selectedSessionTabIdRef.current === selected
      if (!client || connState !== 'connected') {
        return
      }
      const result = await openMobileStructuredSession({
        client,
        source,
        current,
        inventory: {
          worktreeId,
          tabs: scope.sessionTabsRef.current.flatMap((tab) =>
            tab.type === 'agent-session'
              ? [{ id: tab.id, sessionId: tab.sessionId, agent: tab.agent }]
              : []
          )
        }
      })
      if (!current()) {
        return
      }
      if (result.kind === 'opened') {
        if (result.target.worktreeId !== worktreeId) {
          router.push(mobileStructuredSessionHref(hostId, result.target, result.tab))
        } else if (isStructuredAgentId(result.tab.agent)) {
          const existing = scope.sessionTabsRef.current.find((tab) => tab.id === result.tab.id)
          const tab: MobileSessionTab = existing ?? {
            type: 'agent-session',
            id: result.tab.id,
            sessionId: result.target.sessionId,
            agent: result.tab.agent,
            title: result.tab.agent,
            isActive: false
          }
          switchSessionTab(tab, { activate: false })
        }
      } else if (result.kind === 'failed' && result.failure.reason === 'workspace-missing') {
        router.replace(hostRouteWithNotice(hostId, 'worktree-missing'))
      } else if (result.kind === 'failed') {
        showToast(
          mobileStructuredSessionOpenMessage(
            result.failure.reason,
            source.kind === 'sender' ? (source.displayName ?? '') : (source.agent ?? '')
          ),
          3_000
        )
      }
    },
    [
      owner,
      client,
      connState,
      worktreeId,
      hostId,
      executionHost,
      router,
      scope,
      showToast,
      switchSessionTab
    ]
  )
}
