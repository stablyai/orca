import { loadMobileHistoryHandoffAgents } from './mobile-history-handoff-agents'
import { useEffect, useState } from 'react'
import { MessageSquarePlus, Play, SquareTerminal } from 'lucide-react-native'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { agentForksConversations } from '../../../src/shared/agent-launch/startup/agent-resume-argv'
import {
  SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY,
  SESSION_TABS_OWNED_STARTUP_RUNTIME_CAPABILITY
} from '../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileNewTabAgentOption } from '../session/agent-launch/mobile-new-tab-agent-options'
import { supportsMobileExistingAgentLaunch } from '../session/agent-launch/mobile-existing-agent-launch'
import type {
  MobileHistoryResumeResult,
  MobileHistorySessionAction
} from './mobile-history-session-continuation'

export function MobileHistorySessionActionSheets(props: {
  session: AiVaultSession | null
  handoffSession: AiVaultSession | null
  client: RpcClient | null
  worktreeId: string
  worktrees: readonly Worktree[]
  capabilities: readonly string[] | undefined
  busy: boolean
  onRun: (
    session: AiVaultSession,
    action?: MobileHistorySessionAction
  ) => Promise<MobileHistoryResumeResult>
  onHandoff: (session: AiVaultSession) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const { session, handoffSession, client, worktreeId, worktrees, capabilities, onRun, onClose } =
    props
  const [agents, setAgents] = useState<MobileNewTabAgentOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [workspaceChanged, setWorkspaceChanged] = useState(false)
  const [handoffWorktreeId, setHandoffWorktreeId] = useState<string | null>(null)
  useEffect(() => {
    if (!handoffSession || !client) {
      setWorkspaceChanged(false)
      return
    }
    let cancelled = false
    setAgents([])
    setHandoffWorktreeId(null)
    setError('')
    setLoading(true)
    const load = async () => {
      const choices = await loadMobileHistoryHandoffAgents({
        client,
        session: handoffSession,
        worktreeId,
        worktrees,
        assertCurrentOwner: () => {
          if (cancelled) {
            throw new Error('superseded')
          }
        }
      })
      if (!cancelled) {
        setAgents(choices.agents)
        setHandoffWorktreeId(choices.worktreeId)
      }
    }
    void load()
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : t('agentHistory.handoff.detectFailed', 'Could not detect agents on this host.')
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [handoffSession, client, worktreeId, worktrees, t])
  const cliSupported = session?.structuredSession
    ? capabilities?.includes(SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY) === true
    : capabilities?.includes(SESSION_TABS_OWNED_STARTUP_RUNTIME_CAPABILITY) === true
  const handoffSupported = supportsMobileExistingAgentLaunch(capabilities)
  const updateHint = t(
    'agentHistory.actions.updateHost',
    'Update Orca on this host to use this action'
  )
  return (
    <>
      <ActionSheetModal
        visible={session !== null}
        title={session?.title || t('agentHistory.actions.title', 'Session actions')}
        onClose={onClose}
        actions={
          session
            ? [
                {
                  id: 'resume',
                  label: t('agentHistory.actions.resume', 'Resume'),
                  icon: Play,
                  disabled: props.busy,
                  onPress: () => {
                    onClose()
                    void onRun(session)
                  }
                },
                ...((
                  session.structuredSession
                    ? agentForksConversations(session.agent)
                    : session.agent === 'codex' || session.agent === 'claude'
                )
                  ? [
                      {
                        id: 'cli',
                        label: t('session.nativeChatCliFork.resumeInNewCli', 'Resume in New CLI'),
                        icon: SquareTerminal,
                        disabled: props.busy || !cliSupported,
                        hint: cliSupported ? undefined : updateHint,
                        onPress: () => {
                          onClose()
                          void onRun(session, { kind: 'cli' })
                        }
                      }
                    ]
                  : []),
                {
                  id: 'handoff',
                  label: t('agentHistory.actions.handoff', 'Hand off to Another Agent'),
                  icon: MessageSquarePlus,
                  disabled: props.busy || !handoffSupported,
                  hint: handoffSupported ? undefined : updateHint,
                  closeBeforePress: true,
                  onPress: () => props.onHandoff(session)
                }
              ]
            : []
        }
      />
      <ActionSheetModal
        visible={handoffSession !== null}
        title={t('agentHistory.actions.handoff', 'Hand off to Another Agent')}
        message={
          loading
            ? t('agentHistory.handoff.detecting', 'Detecting agents on this workspace host…')
            : error ||
              (workspaceChanged
                ? t(
                    'agentHistory.handoff.workspaceChanged',
                    'The workspace changed. Choose an agent again.'
                  )
                : '') ||
              (agents.length
                ? t(
                    'agentHistory.handoff.context',
                    'Start a fresh session with the latest conversation context.'
                  )
                : t('agentHistory.handoff.empty', 'No enabled agents were detected on this host.'))
        }
        onClose={onClose}
        actions={agents.map(({ agent, label }) => ({
          id: agent,
          label,
          disabled: props.busy || loading || handoffWorktreeId === null,
          onPress: () => {
            if (handoffSession && handoffWorktreeId) {
              onClose()
              void onRun(handoffSession, {
                kind: 'handoff',
                agent,
                worktreeId: handoffWorktreeId
              }).then((result) => {
                if (result?.kind === 'handoff-target-changed') {
                  setWorkspaceChanged(true)
                  props.onHandoff(result.session)
                }
              })
            }
          }
        }))}
      />
    </>
  )
}
