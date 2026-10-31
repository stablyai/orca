import { toAiVaultProjectKey } from '../../../src/shared/ai-vault-project-key'
import { createConversationWorkspaceMatcher } from '../../../src/shared/conversation-workspace-matcher'
import { folderGroupKey, folderLabel } from '../../../src/shared/ai-vault-session-filters'
import {
  conversationPreferenceKey,
  conversationProjectVisibilityKey,
  type ConversationPreferences
} from '../../../src/shared/conversation-navigation-preferences'
import {
  projectConversationTitle,
  isGenericConversationTitle
} from '../../../src/shared/project-conversation-list'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../../../src/shared/project-section-grouping'
import type { ProjectSectionCatalog } from '../worktree/workspace-list-sections'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../src/shared/structured-agent-session-projection'
import { agentDotState, agentRowTimeAt } from '../worktree/agent-row-display'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import { createConversationHistoryIndex } from './conversation-history-index'
import { orderProjectConversations } from './project-conversation-order'
import type { SectionRepo, Worktree } from '../worktree/workspace-list-types'

export { readConversationHistory, readConversationTabs } from './conversation-records'
export type { ConversationHistory, ConversationTab } from './conversation-records'
import type { ConversationHistory, ConversationTab } from './conversation-records'
import type { ConversationProject } from './conversation-project'
export { projectConversationTarget } from './conversation-project'
export type { ConversationRow, ConversationProject } from './conversation-project'

export function conversationTitle(
  values: readonly (string | null | undefined)[],
  workspace: Worktree,
  untitled: string
): string {
  return (
    values
      .map((value) => value?.trim())
      .find(
        (value) =>
          value &&
          !isGenericConversationTitle(value) &&
          value !== workspace.branch &&
          value !== workspace.path &&
          value !== workspace.displayName
      ) ?? untitled
  )
}

export function buildProjectConversations(args: {
  workspaces: readonly Worktree[]
  repos: readonly SectionRepo[]
  tabs: ReadonlyMap<string, readonly ConversationTab[]>
  history: readonly ConversationHistory[]
  now: number
  untitled: string
  query?: string
  projectCatalog?: ProjectSectionCatalog
  preferences?: ConversationPreferences
  archived?: boolean
  visibleHostIds?: readonly ExecutionHostId[] | null
}): ConversationProject[] {
  const projects = new Map<string, ConversationProject>()
  const ownerKeys = new Map<string, string | null>()
  const hostOf = (workspace: Worktree) => workspace.hostId ?? workspace.hostContextHostId ?? 'local'
  const visibleHosts = args.visibleHostIds ? new Set(args.visibleHostIds) : null
  const workspaces = visibleHosts
    ? args.workspaces.filter((workspace) => visibleHosts.has(hostOf(workspace)))
    : args.workspaces
  const history = visibleHosts
    ? args.history.filter(
        (session) => session.executionHostId && visibleHosts.has(session.executionHostId)
      )
    : args.history
  const savedForTab = createConversationHistoryIndex(history)
  const catalog = args.projectCatalog
  const allRepos = catalog?.repos ?? args.repos
  const repos = visibleHosts
    ? allRepos.filter((repo) => visibleHosts.has(getRepoExecutionHostId(repo)))
    : allRepos
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const projectIndex = buildProjectGroupingIndex(catalog?.grouping ?? undefined)
  const groupingFor = (hostId: ExecutionHostId, repoId: string) => {
    const repo = repos.find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    return getProjectGroupingForRepo(
      repoId,
      repo ? new Map(repoMap).set(repoId, repo) : repoMap,
      projectIndex
    )
  }
  const projectKey = (hostId: ExecutionHostId, repoId: string) =>
    `${hostId}\0${groupingFor(hostId, repoId).key}`
  const workspaceProjectKey = (workspace: Worktree) =>
    workspace.workspaceKind === 'folder-workspace'
      ? `${hostOf(workspace)}\0${workspace.worktreeId}`
      : projectKey(hostOf(workspace), workspace.repoId)
  for (const repo of repos) {
    const hostId = getRepoExecutionHostId(repo)
    const key = projectKey(hostId, repo.id)
    const ownerKey = `${hostId}\0${toAiVaultProjectKey(groupingFor(hostId, repo.id).projectId, repo.id)}`
    const previous = ownerKeys.get(ownerKey)
    ownerKeys.set(ownerKey, previous === undefined || previous === key ? key : null)
    if (projects.has(key)) {
      continue
    }
    projects.set(key, {
      key,
      visibilityKey: conversationProjectVisibilityKey(hostId, groupingFor(hostId, repo.id).key),
      title: groupingFor(hostId, repo.id).label,
      hostId,
      repo,
      workspaces: [],
      data: []
    })
  }
  for (const workspace of workspaces) {
    const hostId = hostOf(workspace)
    const key = workspaceProjectKey(workspace)
    let project = projects.get(key)
    if (!project) {
      project = {
        key,
        visibilityKey: conversationProjectVisibilityKey(hostId, workspace.worktreeId),
        title:
          workspace.workspaceKind === 'folder-workspace' ? workspace.displayName : workspace.repo,
        hostId,
        workspaces: [],
        data: []
      }
      projects.set(key, project)
    }
    project.hostLabel ??= workspace.hostContextLabel
    project.hostHealthLabel ??= workspace.hostContextHealthLabel
    project.workspaces.push(workspace)
    const agents = (workspace.agents ?? []).filter((agent) => !agent.parentPaneKey)
    const used = new Set<string>()
    for (const tab of args.tabs.get(getWorktreeRowIdentity(workspace)) ?? []) {
      const paneKey =
        tab.type === 'agent-session' && tab.sessionId
          ? structuredAgentSessionPaneKey(tab.id, tab.sessionId)
          : tab.leafId
            ? `${tab.parentTabId ?? tab.id}:${tab.leafId}`
            : (tab.terminal ?? tab.id)
      const agent = workspace.agents?.find((agent) => agent.paneKey === paneKey)
      if (agent?.parentPaneKey) {
        continue
      }
      const agentType =
        tab.agent ?? tab.launchAgent ?? tab.agentStatus?.agentType ?? agent?.agentType
      if (tab.type === 'terminal' && !agentType && !agent) {
        continue
      }
      used.add(paneKey)
      const saved = savedForTab(tab, hostId, workspace.worktreeId, agentType)
      if (saved?.conversationContent === 'empty') {
        continue
      }
      project.data.push({
        key: `${key}\0${workspace.worktreeId}\0${tab.sessionId ?? paneKey}`,
        title: conversationTitle(
          [agent?.taskTitle, agent?.prompt, saved ? projectConversationTitle(saved) : tab.title],
          workspace,
          args.untitled
        ),
        agent: agentType ?? null,
        status: agent ? agentDotState(agent, args.now) : 'idle',
        at: agent ? agentRowTimeAt(agent) : 0,
        workspace,
        paneKey,
        history: saved,
        preferenceKey: saved
          ? conversationPreferenceKey({ ...saved, executionHostId: hostId })
          : tab.sessionId
            ? conversationPreferenceKey({
                executionHostId: hostId,
                agent: agentType ?? '',
                sessionId: tab.sessionId,
                structuredSession: { sessionId: tab.sessionId, workspaceId: workspace.worktreeId }
              })
            : undefined
      })
    }
    for (const agent of agents) {
      if (used.has(agent.paneKey)) {
        continue
      }
      project.data.push({
        key: `${key}\0${workspace.worktreeId}\0${agent.paneKey}`,
        title: conversationTitle([agent.taskTitle, agent.prompt], workspace, args.untitled),
        agent: agent.agentType,
        status: agentDotState(agent, args.now),
        at: agentRowTimeAt(agent),
        workspace,
        paneKey: agent.paneKey
      })
    }
  }
  const matchWorkspace = createConversationWorkspaceMatcher(
    workspaces.map((workspace) => ({
      ...workspace,
      id: workspace.worktreeId,
      hostId: hostOf(workspace)
    }))
  )
  for (const session of history) {
    if (!session.executionHostId || session.subagent || session.conversationContent === 'empty') {
      continue
    }
    const canonical =
      typeof session.projectOwnerKey === 'string'
        ? projects.get(
            ownerKeys.get(`${session.executionHostId}\0${session.projectOwnerKey}`) ??
              `${session.executionHostId}\0${session.projectOwnerKey}`
          )
        : undefined
    const matched = matchWorkspace({ ...session, executionHostId: session.executionHostId })
    let workspace = matched
      ? (workspaces.find(
          (item) =>
            item.worktreeId === matched.worktreeId && hostOf(item) === session.executionHostId
        ) ?? null)
      : null
    if (
      session.projectOwnerKey !== undefined &&
      workspace &&
      workspace.workspaceKind !== 'folder-workspace' &&
      toAiVaultProjectKey(
        groupingFor(session.executionHostId, workspace.repoId).projectId,
        workspace.repoId
      ) !== session.projectOwnerKey
    ) {
      workspace = null
    }
    const projectKey =
      canonical?.key ??
      (workspace
        ? workspaceProjectKey(workspace)
        : `${session.executionHostId}\0${session.projectOwnerKey ?? folderGroupKey(session.cwd)}`)
    let project = projects.get(projectKey)
    if (!project) {
      project = {
        key: projectKey,
        visibilityKey: conversationProjectVisibilityKey(
          session.executionHostId,
          session.projectOwnerKey ?? folderGroupKey(session.cwd)
        ),
        title: folderLabel(session.cwd) || args.untitled,
        hostId: session.executionHostId,
        workspaces: [],
        data: []
      }
      projects.set(projectKey, project)
    }
    const sessionId = session.structuredSession?.sessionId
    const hostId = session.executionHostId
    const workspaceId = workspace?.worktreeId
    const tab =
      workspace && workspaceId
        ? (args.tabs.get(getWorktreeRowIdentity(workspace)) ?? []).find(
            (tab) => savedForTab(tab, hostId, workspaceId, session.agent) === session
          )
        : undefined
    if (tab) {
      continue
    }
    const key = `${project.key}\0history\0${conversationPreferenceKey({ ...session, executionHostId: session.executionHostId })}`
    if (project.data.some((row) => row.key === key)) {
      continue
    }
    project.data.push({
      key,
      title: workspace
        ? conversationTitle([projectConversationTitle(session)], workspace, args.untitled)
        : projectConversationTitle(session) || args.untitled,
      agent: session.agent,
      status: sessionId ? 'saved' : 'transcript',
      at: Date.parse(session.updatedAt ?? session.modifiedAt) || 0,
      workspace,
      executionHostId: session.executionHostId,
      history: session,
      preferenceKey: conversationPreferenceKey({
        ...session,
        executionHostId: session.executionHostId
      })
    })
  }
  return orderProjectConversations(projects.values(), args)
}
