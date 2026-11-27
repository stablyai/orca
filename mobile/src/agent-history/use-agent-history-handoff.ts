import { useCallback, useState } from 'react'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { AgentSessionContinuationContextMode } from '../../../src/shared/agent-session/conversation-context/agent-session-continuation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import type { MobileNewTabAgentOption } from '../session/agent-launch/mobile-new-tab-agent-options'
import {
  useOpenLaunchedAgent,
  type LaunchedAgentOpens
} from '../session/agent-launch/launched-agent-opener'
import { agentStartedMessage } from '../session/agent-launch/mobile-prompted-agent-launch'
import { agentHistoryHostStatusRead } from './mobile-agent-history-operations'
import { readMobileAiVaultResumeHost } from './ai-vault-resume-launch'
import { prepareMobileHistoryResumeTarget } from './mobile-history-resume-target-preparation'
import {
  launchMobileHistoryHandoff,
  prepareMobileHistoryHandoff,
  supportsMobileHistoryHandoff,
  type MobileHistoryHandoff
} from './mobile-history-session-handoff'

type HandoffTarget = {
  session: AiVaultSession
  handoff: MobileHistoryHandoff
  hostCapabilities: readonly string[] | undefined
}

/** A started agent the user should look at before opening: the host's note, or the context it did not get. */
export type AgentHistoryHandoffLaunchNotice = {
  opens: LaunchedAgentOpens
  warning?: string
  prompt?: string
}

/** History's Hand off to agent: resolves the session's workspace like Resume, then starts the picked agent there. */
export function useAgentHistoryHandoff(args: {
  hostId: string
  worktreeId: string
  client: RpcClient | null
  connState: ConnectionState
  worktrees: readonly Worktree[]
  claimOwnership: () => () => void
  /** Another resume or hand-off is running; this one waits for it. */
  isBusy: () => boolean
  setBusySessionId: (sessionId: string | null) => void
  showMessage: (message: string | null) => void
}) {
  const t = useMobileTranslation()
  const { client, connState, isBusy, claimOwnership, setBusySessionId, showMessage } = args
  // The session already open below gets the pane rather than a second copy of itself.
  const openLaunchedAgent = useOpenLaunchedAgent()
  // Kept past the sheet's close: the picked agent runs once the sheet has gone.
  const [target, setTarget] = useState<HandoffTarget | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [contextMode, setContextMode] = useState<AgentSessionContinuationContextMode>('focused')
  const [notice, setNotice] = useState<AgentHistoryHandoffLaunchNotice | null>(null)
  const fail = useCallback(
    (message: string) => {
      triggerError()
      showMessage(message)
    },
    [showMessage]
  )

  const open = useCallback(
    async (session: AiVaultSession): Promise<void> => {
      if (isBusy()) {
        return
      }
      if (!client || connState !== 'connected') {
        fail(t('agentHistory.panel.waitingForHost', 'Waiting for host...'))
        return
      }
      const assertCurrentOwner = claimOwnership()
      setBusySessionId(session.id)
      showMessage(null)
      setNotice(null)
      try {
        const statusReply = await agentHistoryHostStatusRead.request(client)
        assertCurrentOwner()
        const host = readMobileAiVaultResumeHost(
          interpretOrThrowRefusalMessage(
            () => agentHistoryHostStatusRead.interpret(statusReply),
            t('agentHistory.useAgentHistoryState.hostUnreachable', 'Unable to reach host')
          )
        )
        if (!supportsMobileHistoryHandoff(host.capabilities)) {
          fail(
            t(
              'session.prAiTriageLaunch.updateRequired',
              'Update Orca on this host to start an agent from your phone.'
            )
          )
          return
        }
        // The new agent runs where Resume would continue this session.
        const prepared = await prepareMobileHistoryResumeTarget({
          client,
          session,
          worktreeId: args.worktreeId,
          worktrees: args.worktrees,
          hostPlatform: host.platform,
          assertCurrentOwner,
          unknownPlatformMessage: () =>
            t('agentHistory.panel.unknownHostPlatform', 'Unable to determine host platform.')
        })
        if (prepared.status !== 'ready') {
          fail(prepared.message)
          return
        }
        const handoff = await prepareMobileHistoryHandoff({
          client,
          session,
          worktreeId: prepared.target.worktreeId
        })
        assertCurrentOwner()
        if (!handoff) {
          fail(
            t(
              'agentHistory.handoff.noContext',
              'No session context is available to continue in a new session.'
            )
          )
          return
        }
        setContextMode('focused')
        setTarget({ session, handoff, hostCapabilities: host.capabilities })
        setSheetOpen(true)
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : t('agentHistory.handoff.launchFailed', 'Could not start a new session.')
        )
      } finally {
        setBusySessionId(null)
      }
    },
    [
      isBusy,
      args.worktreeId,
      args.worktrees,
      claimOwnership,
      client,
      connState,
      fail,
      setBusySessionId,
      showMessage,
      t
    ]
  )

  const pick = useCallback(
    async (option: MobileNewTabAgentOption): Promise<void> => {
      const picked = target
      if (!picked || isBusy()) {
        return
      }
      setTarget(null)
      if (!client) {
        fail(t('agentHistory.panel.waitingForHost', 'Waiting for host...'))
        return
      }
      const assertCurrentOwner = claimOwnership()
      setBusySessionId(picked.session.id)
      try {
        const result = await launchMobileHistoryHandoff({
          client,
          hostCapabilities: picked.hostCapabilities,
          handoff: picked.handoff,
          mode: picked.handoff.prompts.full ? contextMode : 'focused',
          option
        })
        // The host accepted or refused the launch; a cutover now only stops navigation.
        try {
          assertCurrentOwner()
        } catch {
          return
        }
        switch (result.kind) {
          case 'sent':
            triggerSuccess()
            // A host note (a terminal instead of a chat, another folder) is read before leaving.
            if (result.warning) {
              setNotice({ opens: result.opens, warning: result.warning })
            } else if (!openLaunchedAgent(result.opens)) {
              showMessage(agentStartedMessage(null))
            }
            return
          case 'prompt-not-sent':
            triggerError()
            setNotice({ opens: result.opens, prompt: result.prompt })
            return
          case 'not-started':
          case 'unconfirmed':
            fail(result.message)
        }
      } finally {
        setBusySessionId(null)
      }
    },
    [
      isBusy,
      claimOwnership,
      client,
      contextMode,
      fail,
      openLaunchedAgent,
      setBusySessionId,
      showMessage,
      t,
      target
    ]
  )

  return {
    open,
    notice,
    dismissNotice: () => setNotice(null),
    sheet: target
      ? {
          client,
          connState,
          hostId: args.hostId,
          hostCapabilities: target.hostCapabilities,
          worktreeId: target.handoff.worktreeId,
          visible: sheetOpen,
          sessionTitle: target.session.title,
          contextMode: target.handoff.prompts.full ? contextMode : null,
          onContextModeChange: setContextMode,
          onClose: () => setSheetOpen(false),
          onClosed: () => setTarget(null),
          onPick: (option: MobileNewTabAgentOption) => void pick(option)
        }
      : null
  }
}
