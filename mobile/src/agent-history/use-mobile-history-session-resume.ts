import { structuredSessionOperationId } from '../session/native-chat/agent-session/structured-session-operation-id'
import type { PendingMobileHistoryHandoff } from './mobile-history-session-handoff'
import { useCallback, useRef, useState } from 'react'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import {
  useResumedHistoryTerminalOpener,
  useHistorySessionPaneOpener
} from './open-resumed-history-terminal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useTransientToast } from '../components/feedback/TransientToast'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import { mobileStructuredSessionOpenMessage } from '../session/native-chat/agent-session/mobile-structured-session-open-message'
import { openMobileAgentHistoryChat } from './open-mobile-agent-history-chat'
import { useMobileResumeOperationOwnership } from './use-mobile-resume-operation-ownership'
import { prepareMobileAiVaultSessionResume } from './ai-vault-resume-preparation'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  readMobileRuntimeTerminalWindowsShell,
  resumeAiVaultSessionInTerminal
} from './ai-vault-resume-launch'
import { refreshMobileHistorySession } from './refresh-mobile-history-session'
import {
  continueMobileHistorySession,
  loadMobileHistoryContinuationTarget,
  MobileHistoryHandoffWorkspaceChanged,
  type MobileHistoryContinuationDestination,
  type MobileHistoryResumeResult,
  type MobileHistorySessionAction
} from './mobile-history-session-continuation'

export function useMobileHistorySessionResume({
  hostId,
  worktreeId,
  origin,
  client,
  connState,
  worktrees
}: {
  hostId: string
  worktreeId: string
  origin: string
  client: RpcClient | null
  connState: ConnectionState
  worktrees: readonly Worktree[]
}) {
  const t = useMobileTranslation()
  const router = useWorkspaceRouteHandoff()
  const openResumedTerminal = useResumedHistoryTerminalOpener(hostId, worktreeId)
  const openSessionPane = useHistorySessionPaneOpener(hostId, worktreeId)
  const claimResumeOwnership = useMobileResumeOperationOwnership(
    hostId,
    worktreeId,
    client,
    connState
  )
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const { message: resumeToast, showToast: showResumeToast } = useTransientToast()
  const [unconfirmedContinuation, setUnconfirmedContinuation] =
    useState<MobileHistoryContinuationDestination | null>(null)
  const handoffs = useRef(new Map<string, PendingMobileHistoryHandoff>())
  const resumeLaunchInFlightRef = useRef(false)
  const resumeMutationRegistryRef = useRef(
    createMobileAiVaultResumeMutationRegistry(() => structuredSessionOperationId())
  )
  const onResumeSession = useCallback(
    async (
      selected: AiVaultSession,
      action: MobileHistorySessionAction = { kind: 'resume' }
    ): Promise<MobileHistoryResumeResult> => {
      if (resumeLaunchInFlightRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        setResumeMessage(t('agentHistory.panel.waitingForHost', 'Waiting for host...'))
        triggerError()
        return
      }

      const assertCurrentOwner = claimResumeOwnership()
      resumeLaunchInFlightRef.current = true
      setResumingSessionId(selected.id)
      setResumeMessage(null)
      setUnconfirmedContinuation(null)
      try {
        const session = await refreshMobileHistorySession(client, selected)
        assertCurrentOwner()
        if (action.kind !== 'resume') {
          const destination = await continueMobileHistorySession({
            client,
            session,
            action,
            worktreeId,
            worktrees,
            assertCurrentOwner,
            mutations: resumeMutationRegistryRef.current,
            handoffs: handoffs.current
          })
          assertCurrentOwner()
          if (destination.warning) {
            setResumeMessage(destination.warning)
            setUnconfirmedContinuation(destination)
            triggerError()
            return
          }
          triggerSuccess()
          openSessionPane({
            ...destination,
            fromSession: origin === 'session' && destination.worktreeId === worktreeId
          })
          return
        }
        if (
          await openMobileAgentHistoryChat({
            client,
            session,
            hostId,
            assertCurrentOwner,
            opened: (href) => {
              triggerSuccess()
              router.replace(href)
            },
            failed: (reason, workspaceKind) => {
              triggerError()
              const message = mobileStructuredSessionOpenMessage(
                reason,
                session.agent,
                undefined,
                workspaceKind
              )
              const showMessage =
                reason === 'workspace-missing' ? showResumeToast : setResumeMessage
              showMessage(message)
            }
          })
        ) {
          return
        }
        if (!session.sessionId) {
          setResumeMessage(
            t('agentHistory.panel.missingResumeId', 'This session is missing a resume id.')
          )
          triggerError()
          return
        }
        const {
          target,
          platform,
          settings,
          host: resumeHost,
          status: hostStatus
        } = await loadMobileHistoryContinuationTarget({
          client,
          session,
          worktreeId,
          worktrees,
          assertCurrentOwner
        })

        const preparedSession = await prepareMobileAiVaultSessionResume(client, session)
        assertCurrentOwner()
        const mutationKey = JSON.stringify([
          session.id,
          session.sessionId,
          session.executionHostId,
          target.worktreeId
        ])
        const launch = resumeMutationRegistryRef.current.claimLaunch(mutationKey, () =>
          buildMobileAiVaultResumeLaunch({
            session: preparedSession,
            workspacePlatform: platform,
            hostTerminalWindowsShell: readMobileRuntimeTerminalWindowsShell(hostStatus),
            settings
          })
        )
        const resumed = await resumeAiVaultSessionInTerminal(
          client,
          target.worktreeId,
          {
            ...launch,
            hostCapabilities: resumeHost.capabilities
          },
          assertCurrentOwner
        )
        resumeMutationRegistryRef.current.releaseOnSuccess(mutationKey)
        triggerSuccess()
        // The host accepted the resume; a cutover now only stops navigation.
        try {
          assertCurrentOwner()
        } catch {
          return
        }
        setResumeMessage(t('agentHistory.panel.sessionQueued', 'Agent session queued.'))
        openResumedTerminal({
          worktreeId: target.worktreeId,
          resumed,
          fromSession: origin === 'session' && target.worktreeId === worktreeId
        })
      } catch (err) {
        triggerError()
        if (err instanceof MobileHistoryHandoffWorkspaceChanged) {
          setResumeMessage(err.message)
          return { kind: 'handoff-target-changed', session: err.session }
        }
        setResumeMessage(
          err instanceof Error
            ? err.message
            : t('agentHistory.panel.resumeFailed', 'Failed to resume session.')
        )
      } finally {
        resumeLaunchInFlightRef.current = false
        setResumingSessionId(null)
      }
    },
    [
      client,
      connState,
      hostId,
      origin,
      openResumedTerminal,
      openSessionPane,
      router,
      worktreeId,
      worktrees,
      claimResumeOwnership,
      showResumeToast,
      t
    ]
  )

  const openUnconfirmedContinuation = unconfirmedContinuation
    ? () => {
        openSessionPane({
          ...unconfirmedContinuation,
          fromSession: origin === 'session' && unconfirmedContinuation.worktreeId === worktreeId
        })
        setUnconfirmedContinuation(null)
        setResumeMessage(null)
      }
    : undefined
  return {
    onResumeSession,
    resumingSessionId,
    resumeMessage,
    setResumeMessage,
    resumeToast,
    openUnconfirmedContinuation
  }
}
