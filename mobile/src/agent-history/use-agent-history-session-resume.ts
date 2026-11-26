import { useCallback, useRef, useState } from 'react'
import { openMobileAgentHistoryChat } from './open-mobile-agent-history-chat'
import { mobileStructuredSessionOpenMessage } from '../session/native-chat/agent-session/mobile-structured-session-open-message'
import { prepareMobileHistoryResumeTarget } from './mobile-history-resume-target-preparation'
import { useResumedHistoryTerminalOpener } from './open-resumed-history-terminal'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  readMobileAiVaultResumeHost,
  readMobileRuntimeTerminalWindowsShell,
  resumeAiVaultSessionInTerminal
} from './ai-vault-resume-launch'
import {
  aiVaultResumeRefusalText,
  prepareMobileAiVaultSessionResume
} from './ai-vault-resume-preparation'
import { hostViewModeForNewAgentTab } from '../storage/session-view-preferences'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import type * as AiVault from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { agentHistoryHostStatusRead } from './mobile-agent-history-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { useTransientToast } from '../components/feedback/TransientToast'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'

/** History's Resume: the session's own chat when one holds it, else a terminal the host prepared. */
export function useAgentHistorySessionResume({
  hostId,
  worktreeId,
  origin,
  client,
  connState,
  worktrees,
  claimResumeOwnership
}: {
  hostId: string
  worktreeId: string
  origin: string
  client: RpcClient | null
  connState: ConnectionState
  worktrees: readonly Worktree[]
  claimResumeOwnership: () => () => void
}) {
  const t = useMobileTranslation()
  // Use handoff, not useRouter: resumed session is a native route outside this single-document page.
  const router = useWorkspaceRouteHandoff()
  const openResumedTerminal = useResumedHistoryTerminalOpener(hostId, worktreeId)
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const { message: resumeToast, showToast: showResumeToast } = useTransientToast()
  const resumeLaunchInFlightRef = useRef(false)
  const resumeMutationRegistryRef = useRef(
    createMobileAiVaultResumeMutationRegistry(createMobileAiVaultResumeMutationId)
  )
  // Hand-off shares the row spinner and the one-at-a-time guard.
  const setBusySessionId = useCallback((sessionId: string | null) => {
    resumeLaunchInFlightRef.current = sessionId !== null
    setResumingSessionId(sessionId)
  }, [])
  const isBusy = useCallback(() => resumeLaunchInFlightRef.current, [])

  const onResumeSession = useCallback(
    async (session: AiVault.AiVaultSession): Promise<void> => {
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
      setResumingSessionId(session.id)
      setResumeMessage(null)
      try {
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
        // Read at resume, not on open: the Windows shell setting can change while connected.
        const statusReply = await agentHistoryHostStatusRead.request(client)
        assertCurrentOwner()
        const hostStatus = interpretOrThrowRefusalMessage(
          () => agentHistoryHostStatusRead.interpret(statusReply),
          t('agentHistory.useAgentHistoryState.hostUnreachable', 'Unable to reach host')
        )
        const resumeHost = readMobileAiVaultResumeHost(hostStatus)
        const preparedTarget = await prepareMobileHistoryResumeTarget({
          client,
          session,
          worktreeId,
          worktrees,
          hostPlatform: resumeHost.platform,
          assertCurrentOwner,
          unknownPlatformMessage: () =>
            t('agentHistory.panel.unknownHostPlatform', 'Unable to determine host platform.')
        })
        if (preparedTarget.status !== 'ready') {
          setResumeMessage(preparedTarget.message)
          triggerError()
          return
        }
        const { target, platform, settings } = preparedTarget

        const preparedSession = await prepareMobileAiVaultSessionResume(client, session)
        assertCurrentOwner()
        const launch = buildMobileAiVaultResumeLaunch({
          session: preparedSession,
          workspacePlatform: platform,
          hostTerminalWindowsShell: readMobileRuntimeTerminalWindowsShell(hostStatus),
          settings
        })
        const resumed = await resumeAiVaultSessionInTerminal(
          client,
          target.worktreeId,
          {
            ...launch,
            hostCapabilities: resumeHost.capabilities,
            clientMutationId: resumeMutationRegistryRef.current.claim(session.id),
            viewMode: await hostViewModeForNewAgentTab(launch.launchAgent)
          },
          assertCurrentOwner
        )
        resumeMutationRegistryRef.current.releaseOnSuccess(session.id)
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
        setResumeMessage(
          err instanceof Error
            ? (aiVaultResumeRefusalText(err.message, session.agent) ?? err.message)
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
      router,
      worktreeId,
      worktrees,
      claimResumeOwnership,
      showResumeToast,
      t
    ]
  )

  return {
    onResumeSession,
    resumingSessionId,
    resumeMessage,
    setResumeMessage,
    resumeToast,
    setBusySessionId,
    isBusy,
    resumeLaunchInFlightRef,
    setResumingSessionId
  }
}

function createMobileAiVaultResumeMutationId(sessionId: string): string {
  const sessionPart = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'session'
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `ai-vault-resume:${sessionPart}:${Date.now().toString(36)}:${randomPart}`
}
