import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import { sessionTabPaneKey } from '../../../src/shared/remote-runtime/session-graph/session-tab-pane-key'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useNativeVerbs } from '../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import type { MobileSessionFoundationModel } from '../session/use-mobile-session-foundation'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'

export function useSessionLiveActivity(
  model: Pick<MobileSessionFoundationModel, 'worktreeId'> & {
    activeSessionTab: MobileSessionTab | null | undefined
  }
): void {
  const native = useNativeVerbs()
  const executionHost = useWorkspaceExecutionHost()
  const tab = model.activeSessionTab
  const paneKey = sessionTabPaneKey(tab)
  const status =
    tab?.type === 'terminal'
      ? tab.agentStatus
      : tab?.type === 'agent-session'
        ? tab.chatStatus
        : undefined
  const working = status?.state === 'working'
  const turnKey =
    status && 'turnStartedAt' in status && status.turnStartedAt
      ? String(status.turnStartedAt)
      : status?.mainAgent?.stateStartedAt
        ? String(status.mainAgent.stateStartedAt)
        : status && 'stateStartedAt' in status
          ? String(status.stateStartedAt)
          : ''
  useFocusEffect(
    useCallback(() => {
      if (working && paneKey && turnKey) {
        void native
          .trackLiveActivity({
            worktreeId: model.worktreeId,
            paneKey,
            turnKey,
            ...(executionHost ? { executionHost } : {})
          })
          .catch(() => undefined)
      }
    }, [working, paneKey, turnKey, model.worktreeId, executionHost, native])
  )
}
