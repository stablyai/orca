import { translate } from '../i18n/mobile-i18n'
import type { SideChatPermission } from '../../../src/shared/agent-session-side-chat'
import type { AgentJournalSkillRef } from '../../../src/shared/agent-session-journal-types'
import { useCallback } from 'react'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'
import {
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch,
  resolveLaunchedSelection
} from './pending-session-selection'
import { structuredSessionOperationId } from './structured-session-operation-id'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'

export async function openMobileSideChat(input: {
  client: RpcClient
  worktreeId: string
  sessionId: string
  agent: string
  permission?: SideChatPermission
  question?: string
  skills?: readonly AgentJournalSkillRef[]
  onError: (message: string) => void
  navigation: Pick<
    MobileSessionFeedbackCapabilitiesModel,
    'pendingSelectionRef' | 'sessionTabsRef' | 'switchSessionTabRef'
  >
}): Promise<boolean> {
  const { pendingSelectionRef, sessionTabsRef, switchSessionTabRef } = input.navigation
  let lock: string | undefined
  let result: Awaited<ReturnType<typeof createMobileStructuredAgentSession>>
  try {
    lock = structuredSessionOperationId()
    pendingSelectionRef.current = launchedSelection(lock, {}, null)
    result = await createMobileStructuredAgentSession(
      input.client,
      input.worktreeId,
      input.agent,
      input.sessionId,
      input.question,
      input.skills,
      input.permission
    )
  } catch {
    if (lock !== undefined) {
      pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, lock)
    }
    input.onError(translate('session.sideChat.failed', 'Could not open a side chat.'))
    return false
  }
  const sessionId = 'sessionId' in result ? result.sessionId : undefined
  if (sessionId) {
    pendingSelectionRef.current = withLaunchReply(pendingSelectionRef.current, lock, { sessionId })
    const landed = resolveLaunchedSelection(pendingSelectionRef.current, sessionTabsRef.current)
    const tab = sessionTabsRef.current.find((entry) => entry.id === landed.landedTabId)
    if (tab) {
      switchSessionTabRef.current?.(tab)
    }
    if (result.kind === 'created') {
      return true
    }
  } else {
    pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, lock)
  }
  input.onError(
    'message' in result
      ? result.message
      : translate('session.sideChat.unsupportedHost', 'This host cannot open a side chat.')
  )
  return false
}

export function useMobileSideChat(scope: MobileSessionFeedbackCapabilitiesModel) {
  const { client, agentSessionHostSupport, worktreeId, showToast, activeSessionTab } = scope
  const handleOpenSideChat = useCallback(
    async (
      tab: Extract<MobileSessionTab, { type: 'agent-session' }>,
      question = '',
      skills?: readonly AgentJournalSkillRef[],
      permission: SideChatPermission = 'inherit'
    ) => {
      const current = scope.sessionTabsRef.current.find((entry) => entry.id === tab.id)
      if (
        !client ||
        scope.clientRef.current !== client ||
        !agentSessionHostSupport?.sideChat ||
        current?.type !== 'agent-session' ||
        current.sessionId !== tab.sessionId ||
        current.agent !== tab.agent ||
        !current.sideChatSupported
      ) {
        showToast(
          translate(
            'session.sideChat.unavailable',
            'This chat is not currently available for a side chat.'
          ),
          3000
        )
        return false
      }
      if (permission === 'read-only' && !agentSessionHostSupport.readOnlySideChat) {
        showToast(
          translate(
            'session.sideChat.updateHostForReadOnly',
            'Update Orca on this host to open a read-only side chat.'
          ),
          3000
        )
        return false
      }
      return openMobileSideChat({
        client,
        worktreeId,
        sessionId: tab.sessionId,
        agent: tab.agent,
        question,
        skills,
        permission,
        navigation: {
          pendingSelectionRef: scope.pendingSelectionRef,
          sessionTabsRef: scope.sessionTabsRef,
          switchSessionTabRef: scope.switchSessionTabRef
        },
        onError: (message) => showToast(message, 3000)
      })
    },
    [
      client,
      scope.clientRef,
      scope.sessionTabsRef,
      scope.pendingSelectionRef,
      scope.switchSessionTabRef,
      agentSessionHostSupport?.sideChat,
      agentSessionHostSupport?.readOnlySideChat,
      worktreeId,
      showToast
    ]
  )
  const openCurrentSideChat = useCallback(
    (question: string, skills?: readonly AgentJournalSkillRef[]) =>
      activeSessionTab?.type === 'agent-session'
        ? handleOpenSideChat(activeSessionTab, question, skills)
        : Promise.resolve(false),
    [activeSessionTab, handleOpenSideChat]
  )
  return {
    handleOpenSideChat,
    openCurrentSideChat:
      activeSessionTab?.type === 'agent-session' &&
      activeSessionTab.sideChatSupported &&
      agentSessionHostSupport?.sideChat
        ? openCurrentSideChat
        : undefined
  }
}
