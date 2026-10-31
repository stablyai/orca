import { useEffect, useRef, useState } from 'react'
import { rpcClientForExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import {
  loadMobileNewTabAgentOptions,
  hostRefusesOtherRuntimeWorkspace
} from '../session/mobile-new-tab-agent-loader'
import {
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from '../session/mobile-existing-agent-launch'
import type { MobileNewTabAgentOption } from '../session/mobile-new-tab-agent-options'
import type { Worktree } from '../worktree/workspace-list-types'
import type { HostScreenController } from './use-host-screen-controller'
import type { useProjectConversations } from './use-project-conversations'
import {
  projectConversationTarget,
  type ConversationProject,
  type ConversationRow
} from './project-conversations'
import { conversationOpenPane } from './conversation-open'
import { conversationCopy } from './conversation-copy'

export function useConversationActions(
  controller: Pick<
    HostScreenController,
    'client' | 'hostCapabilities' | 'hostId' | 'connState' | 'actions'
  >,
  data: ReturnType<typeof useProjectConversations>
) {
  const { client, hostCapabilities, hostId, connState, actions } = controller
  const { generation } = data
  const copy = conversationCopy()
  const [chatChoice, setChatChoice] = useState<{
    client: typeof client
    hostId: typeof hostId
    generation: number
    project: ConversationProject
    workspace: Worktree
    agents: MobileNewTabAgentOption[]
  } | null>(null)
  const [busyOwner, setBusyOwner] = useState<{
    client: typeof client
    hostId: typeof hostId
    generation: number
    key: string
  } | null>(null)
  const [errorOwner, setErrorOwner] = useState<{
    client: typeof client
    hostId: typeof hostId
    generation: number
    message: string
  } | null>(null)
  const newChat =
    chatChoice?.client === client &&
    chatChoice.hostId === hostId &&
    chatChoice.generation === generation
      ? chatChoice
      : null
  const busy =
    busyOwner?.client === client &&
    busyOwner.hostId === hostId &&
    busyOwner.generation === generation
      ? busyOwner.key
      : null
  const error =
    errorOwner?.client === client &&
    errorOwner.hostId === hostId &&
    errorOwner.generation === generation
      ? errorOwner.message
      : ''
  const setError = (message: string) => setErrorOwner({ client, hostId, generation, message })
  const setNewChat = (_value: null) => setChatChoice(null)
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const owner = useRef({ client, hostId, connState })
  owner.current = { client, hostId, connState }
  async function perform(key: string, run: (isCurrent: () => boolean) => Promise<void>) {
    if (
      locked.current ||
      connState !== 'connected' ||
      generation !== (client?.getGeneration?.() ?? 0)
    ) {
      return
    }
    const captured = owner.current
    const current = () =>
      mounted.current &&
      owner.current.connState === 'connected' &&
      owner.current.client === captured.client &&
      owner.current.hostId === captured.hostId &&
      generation === (client?.getGeneration?.() ?? 0)
    locked.current = true
    setBusyOwner({ client, hostId, generation, key })
    setError('')
    try {
      await run(current)
    } catch (error) {
      if (current()) {
        setError(
          error instanceof Error && error.message !== 'conversation_host_update_required'
            ? error.message
            : copy.update
        )
      }
    } finally {
      locked.current = false
      if (current()) {
        setBusyOwner(null)
      }
    }
  }

  function rowClient(workspace: Worktree) {
    const scoped = client && rpcClientForExecutionHost(client, hostCapabilities, workspace.hostId)
    if (!scoped) {
      throw new Error(copy.unavailable)
    }
    return scoped
  }

  function open(row: ConversationRow) {
    void perform(row.key, async (current) => {
      if (!row.workspace) {
        if (row.history) {
          const executionHost = row.executionHostId?.startsWith('runtime:')
            ? `&executionHost=${encodeURIComponent(row.executionHostId)}`
            : ''
          actions.navigateFromHostList(
            `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent(row.history.structuredSession?.workspaceId ?? 'history')}?name=${encodeURIComponent(row.title)}&conversationId=${encodeURIComponent(row.history.id)}${executionHost}`,
            true
          )
        }
        return
      }
      const paneKey = await conversationOpenPane({
        row,
        client: rowClient(row.workspace),
        capabilities: data.capabilitiesFor(row.workspace.hostId ?? 'local')
      })
      if (!current()) {
        return
      }
      if (paneKey) {
        actions.openWorktreeSession({ ...row.workspace, displayName: row.title }, paneKey)
      } else if (row.history) {
        const executionHost = row.workspace.hostId?.startsWith('runtime:')
          ? `&executionHost=${encodeURIComponent(row.workspace.hostId)}`
          : ''
        actions.navigateFromHostList(
          `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent(row.workspace.worktreeId)}?name=${encodeURIComponent(row.title)}&conversationId=${encodeURIComponent(row.history.id)}${executionHost}`,
          true
        )
      }
    })
  }

  function prepare(project: ConversationProject) {
    const workspace = projectConversationTarget(project)
    if (!workspace) {
      setError(copy.workspaceNeeded)
      return
    }
    void perform(project.key, async (current) => {
      const capabilities = data.capabilitiesFor(project.hostId)
      if (!supportsMobileExistingAgentLaunch(capabilities)) {
        throw new Error(copy.update)
      }
      const inventory = await loadMobileNewTabAgentOptions({
        client: rowClient(workspace),
        worktreeId: workspace.worktreeId,
        hostRefusesOtherRuntime: hostRefusesOtherRuntimeWorkspace(capabilities)
      })
      if (!current()) {
        return
      }
      if (inventory.options.length === 0) {
        setError(copy.noAgents)
        return
      }
      setChatChoice({ client, hostId, generation, project, workspace, agents: inventory.options })
    })
  }

  function launch(option: MobileNewTabAgentOption) {
    if (!newChat) {
      return
    }
    const target = newChat
    setNewChat(null)
    void perform(target.project.key, async (current) => {
      const launched = await launchAgentInExistingWorkspace({
        client: rowClient(target.workspace),
        hostCapabilities: data.capabilitiesFor(target.project.hostId),
        worktreeId: target.workspace.worktreeId,
        agent: option.agent
      })
      if (!current()) {
        return
      }
      if (launched.kind === 'unsupported') {
        throw new Error(copy.update)
      }
      if (launched.kind !== 'launched') {
        throw new Error(launched.message)
      }
      if (launched.result.worktreeId !== target.workspace.worktreeId) {
        throw new Error(copy.unavailable)
      }
      const outcome = launched.result.outcome
      const paneKey =
        outcome.kind === 'structured'
          ? structuredAgentSessionPaneKey(
              structuredAgentSessionTabId(outcome.sessionId),
              outcome.sessionId
            )
          : outcome.handle
      actions.openWorktreeSession({ ...target.workspace, displayName: copy.untitled }, paneKey)
      data.onRefresh()
    })
  }

  return { busy, error, newChat, setNewChat, prepare, launch, open }
}
