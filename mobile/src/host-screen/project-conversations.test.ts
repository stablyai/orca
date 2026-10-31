import { describe, expect, it } from 'vitest'
import { conversationPreferenceKey } from '../../../src/shared/conversation-navigation-preferences'
import type { ProjectSectionCatalog } from '../worktree/workspace-list-sections'
import { structuredAgentSessionPaneKey } from '../../../src/shared/structured-agent-session-projection'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import {
  buildProjectConversations,
  projectConversationTarget,
  readConversationHistory
} from './project-conversations'
import type { ConversationTab } from './project-conversations'
import {
  conversationAgent,
  conversationHistory,
  conversationWorkspace
} from './project-conversations.test-fixture'

const defaults = {
  repos: [],
  tabs: new Map(),
  history: [],
  now: 1000,
  untitled: 'New conversation'
}

describe('projects containing conversations', () => {
  it.each([
    { type: 'terminal', id: 'child', terminal: 'worker', launchAgent: 'codex', title: 'Worker' },
    {
      type: 'terminal',
      id: 'child',
      parentTabId: 'split',
      leafId: 'leaf',
      agentStatus: { agentType: 'codex' },
      title: 'Worker'
    }
  ] satisfies ConversationTab[])('excludes known child terminal tabs: $id $leafId', (tab) => {
    const paneKey = tab.leafId ? `${tab.parentTabId}:${tab.leafId}` : tab.terminal
    const workspace = conversationWorkspace({
      agents: [conversationAgent({ paneKey: paneKey ?? 'worker', parentPaneKey: 'parent' })]
    })
    const [project] = buildProjectConversations({
      ...defaults,
      workspaces: [workspace],
      tabs: new Map([[getWorktreeRowIdentity(workspace), [tab]]])
    })
    expect(project?.data).toEqual([])

    const [legacy] = buildProjectConversations({
      ...defaults,
      workspaces: [{ ...workspace, agents: undefined }],
      tabs: new Map([[getWorktreeRowIdentity(workspace), [tab]]])
    })
    expect(legacy?.data).toHaveLength(1)
    expect(legacy?.data[0]?.paneKey).toBe(paneKey)
  })

  it('flattens root agent conversations across workspaces and excludes worker panes', () => {
    const one = conversationWorkspace({
      agents: [
        conversationAgent(),
        conversationAgent({ paneKey: 'worker', parentPaneKey: 'chat-pane' })
      ]
    })
    const two = conversationWorkspace({
      worktreeId: 'sibling',
      branch: 'master',
      agents: [conversationAgent({ paneKey: 'other', taskTitle: 'Polish the composer' })]
    })
    const projects = buildProjectConversations({ ...defaults, workspaces: [one, two] })
    expect(projects).toHaveLength(1)
    expect(projects[0]?.title).toBe('Atlas')
    expect(projects[0]?.data.map((row) => row.title)).toEqual([
      'Clearer navigation',
      'Polish the composer'
    ])
    expect(projects[0]?.data.map((row) => row.paneKey)).toEqual(['chat-pane', 'other'])
  })

  it('keeps persisted empty folder chats with their recorded workspace and provider after restart', () => {
    const folder = conversationWorkspace({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:notes',
      repoId: 'notes',
      repo: 'Notes',
      path: '/documents/notes',
      branch: '',
      isMainWorktree: false
    })
    const saved = conversationHistory({
      title: 'An empty saved chat',
      cwd: null,
      structuredSession: { sessionId: 'saved-chat', workspaceId: folder.worktreeId }
    })
    const [project] = buildProjectConversations({
      ...defaults,
      workspaces: [folder],
      history: [saved]
    })
    expect(project?.data).toEqual([
      expect.objectContaining({
        title: saved.title,
        status: 'saved',
        workspace: folder,
        agent: 'claude'
      })
    ])
    expect(project && projectConversationTarget(project)).toBe(folder)
  })

  it('deduplicates an open structured conversation against retained history', () => {
    const workspace = conversationWorkspace()
    const sessionId = 'saved-chat'
    const tabs = new Map([
      [
        getWorktreeRowIdentity(workspace),
        [
          {
            type: 'agent-session' as const,
            id: 'tab-one',
            title: 'Human conversation',
            agent: 'codex',
            sessionId
          }
        ]
      ]
    ])
    const saved = conversationHistory({
      structuredSession: { sessionId, workspaceId: workspace.worktreeId }
    })
    const [project] = buildProjectConversations({
      ...defaults,
      workspaces: [workspace],
      tabs,
      history: [saved]
    })
    expect(project?.data).toHaveLength(1)
    expect(project?.data[0]?.paneKey).toBe(structuredAgentSessionPaneKey('tab-one', sessionId))
  })

  it('does not cross host boundaries when workspace ids and paths are identical', () => {
    const local = conversationWorkspace()
    const remote = conversationWorkspace({
      hostId: 'runtime:server',
      hostContextLabel: 'Build server'
    })
    const ssh = conversationWorkspace({ hostId: 'ssh:target', hostContextLabel: 'SSH' })
    const saved = conversationHistory({ executionHostId: 'runtime:server' })
    const projects = buildProjectConversations({
      ...defaults,
      workspaces: [local, remote, ssh],
      history: [saved]
    })
    expect(projects).toHaveLength(3)
    expect(
      projects.filter((project) => project.data.length).map((project) => project.hostId)
    ).toEqual(['runtime:server'])
  })

  it('uses the nearest recorded directory without guessing ownership from a branch name', () => {
    const parent = conversationWorkspace({ path: 'C:\\projects', worktreeId: 'parent' })
    const child = conversationWorkspace({
      path: 'C:\\projects\\atlas',
      worktreeId: 'child',
      repoId: 'child',
      repo: 'Atlas child',
      branch: 'claude-opus'
    })
    const project = buildProjectConversations({
      ...defaults,
      workspaces: [parent, child],
      history: [conversationHistory({ cwd: 'C:\\projects\\atlas\\src' })]
    }).find((project) => project.data.length)
    expect(project?.data[0]?.workspace).toBe(child)
    expect(project?.data[0]?.agent).toBe('claude')
  })

  it('never promotes branch or worktree names to conversation titles or guesses an agent', () => {
    const workspace = conversationWorkspace({
      branch: 'claude-opus',
      displayName: 'claude-opus',
      agents: [conversationAgent({ taskTitle: 'claude-opus', prompt: '', agentType: null })]
    })
    const [project] = buildProjectConversations({ ...defaults, workspaces: [workspace] })
    expect(project?.data[0]).toMatchObject({ title: 'New conversation', agent: null })
  })

  it('searches conversation titles and agents without searching technical branch metadata', () => {
    const workspace = conversationWorkspace({ agents: [conversationAgent()] })
    expect(
      buildProjectConversations({ ...defaults, workspaces: [workspace], query: 'private-branch' })
    ).toEqual([])
    expect(
      buildProjectConversations({ ...defaults, workspaces: [workspace], query: 'clearer' })[0]?.data
    ).toHaveLength(1)
  })

  it('uses canonical recent and manual ordering from the served project catalog', () => {
    const repos = ['Beta', 'Alpha', 'Pinned'].map((displayName) => ({
      id: displayName,
      displayName,
      path: `/projects/${displayName}`
    }))
    const projectCatalog: ProjectSectionCatalog = {
      repos,
      grouping: {
        projects: repos.map((repo) => ({ id: `github:${repo.id}`, displayName: repo.displayName })),
        projectHostSetups: repos.map((repo) => ({
          id: repo.id,
          projectId: `github:${repo.id}`,
          hostId: 'local',
          repoId: repo.id,
          path: repo.path,
          displayName: repo.displayName,
          setupMethod: 'imported-existing-folder'
        }))
      },
      repoOrder: new Map(repos.map((repo, index) => [repo.id, index])),
      projectOrderBy: 'recent'
    }
    const workspaces = repos.map((repo) =>
      conversationWorkspace({
        repoId: repo.id,
        repo: repo.displayName,
        worktreeId: repo.id,
        path: repo.path,
        lastActivityAt: repo.id === 'Alpha' ? 9999 : 0
      })
    )
    const titles = () =>
      buildProjectConversations({ ...defaults, repos, workspaces, projectCatalog }).map(
        (project) => project.title
      )

    expect(titles()).toEqual(['Alpha', 'Beta', 'Pinned'])
    projectCatalog.projectOrderBy = 'manual'
    expect(titles()).toEqual(['Beta', 'Alpha', 'Pinned'])
  })

  it('shares chat pins and archive identity while hiding only confirmed empty history', () => {
    const saved = conversationHistory({
      title: 'Codex Chat',
      agent: 'codex',
      firstUserPrompt: 'Repair the history scroll',
      structuredSession: {
        sessionId: 'native-chat',
        workspaceId: conversationWorkspace().worktreeId
      }
    })
    const newer = conversationHistory({
      id: 'newer',
      sessionId: 'provider-newer',
      modifiedAt: '2026-10-25T12:00:00Z'
    })
    const empty = conversationHistory({
      id: 'empty',
      sessionId: 'provider-empty',
      conversationContent: 'empty'
    })
    const unknown = conversationHistory({
      id: 'unknown',
      sessionId: 'provider-unknown',
      conversationContent: 'unknown'
    })
    const key = conversationPreferenceKey({ ...saved, executionHostId: 'local' })
    const preferences = { revision: 1, entries: { [key]: { pinned: true, archived: false } } }
    const args = {
      ...defaults,
      workspaces: [conversationWorkspace()],
      history: [newer, saved, empty, unknown],
      preferences
    }
    const active = buildProjectConversations(args)[0]?.data
    expect(active?.map((row) => row.history?.id)).toEqual([saved.id, newer.id, unknown.id])
    expect(active?.[0]?.title).toBe('Repair the history scroll')

    preferences.entries[key] = { pinned: true, archived: true }
    expect(buildProjectConversations(args)[0]?.data.map((row) => row.history?.id)).toEqual([
      newer.id,
      unknown.id
    ])
    expect(
      buildProjectConversations({ ...args, archived: true })[0]?.data.map((row) => row.history?.id)
    ).toEqual([saved.id])
    preferences.entries[key] = { pinned: true, archived: false }
    expect(buildProjectConversations({ ...args, archived: true })).toEqual([])
    expect(buildProjectConversations(args)[0]?.data[0]?.preferenceKey).toBe(key)
  })

  it('leaves old-host durable coverage unconfirmed rather than claiming no saved conversations', () => {
    expect(readConversationHistory({ sessions: [] }).includesStructuredSessions).toBeUndefined()
    expect(
      readConversationHistory({ sessions: [], includesStructuredSessions: true })
        .includesStructuredSessions
    ).toBe(true)
  })
})
