import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import { expect, it } from 'vitest'
import { buildProjectConversations, projectConversationTarget } from './project-conversations'
import { conversationHistory, conversationWorkspace } from './project-conversations.test-fixture'
import { updateConversationPreference } from '../../../src/shared/conversation-navigation-preferences'

const defaults = {
  repos: [],
  tabs: new Map(),
  workspaces: [],
  history: [],
  now: 1000,
  untitled: 'New conversation'
}

it('keeps discovered history groups reversible without inventing a workspace target', () => {
  const history = [conversationHistory({ cwd: '/lost/notes', filePath: '/logs/one.jsonl' })]
  const [project] = buildProjectConversations({ ...defaults, history })
  expect(project?.data).toHaveLength(1)
  expect(project?.data[0]?.workspace).toBeNull()
  expect(project && projectConversationTarget(project)).toBeNull()
  if (!project?.visibilityKey) {
    throw new Error('missing visibility identity')
  }
  const hidden = updateConversationPreference(null, {
    projectKey: project.visibilityKey,
    label: project.title,
    hidden: true
  })
  expect(buildProjectConversations({ ...defaults, history, preferences: hidden })).toEqual([])
  const restored = updateConversationPreference(hidden, {
    projectKey: project.visibilityKey,
    label: project.title,
    hidden: false
  })
  expect(
    buildProjectConversations({ ...defaults, history, preferences: restored })[0]?.data[0]?.history
  ).toEqual(history[0])
})

it('respects canonical project ownership over a conflicting recorded cwd', () => {
  const workspace = conversationWorkspace({ repoId: 'one', path: '/projects/one' })
  const repos = ['one', 'two'].map((id) => ({ id, path: `/projects/${id}`, displayName: id }))
  const history = [
    conversationHistory({
      cwd: workspace.path,
      projectOwnerKey: 'repo:two',
      filePath: '/logs/one.jsonl'
    })
  ]
  const projects = buildProjectConversations({
    ...defaults,
    repos,
    workspaces: [workspace],
    history
  })
  expect(projects.find((project) => project.repo?.id === 'one')?.data).toEqual([])
  expect(projects.find((project) => project.repo?.id === 'two')?.data[0]?.workspace).toBeNull()
  expect(projects.find((project) => project.repo?.id === 'two')?.data[0]?.history).toEqual(
    history[0]
  )
})

it('keeps ambiguous native transcripts distinct when an open tab shares their provider ID', () => {
  const workspace = conversationWorkspace()
  const history = [
    conversationHistory({ id: 'native', filePath: '/logs/same.jsonl' }),
    conversationHistory({ id: 'wsl', filePath: '\\\\wsl$\\Ubuntu\\home\\me\\same.jsonl' })
  ]
  const projects = buildProjectConversations({
    ...defaults,
    workspaces: [workspace],
    history,
    tabs: new Map([
      [
        getWorktreeRowIdentity(workspace),
        [
          {
            type: 'terminal' as const,
            id: 'tab',
            title: 'Open',
            agent: 'claude',
            agentStatus: { sessionId: 'provider-one', agentType: 'claude' }
          }
        ]
      ]
    ])
  })
  expect(projects.flatMap((project) => project.data).filter((row) => row.history)).toHaveLength(2)
  expect(
    new Set(projects.flatMap((project) => project.data).map((row) => row.preferenceKey)).size
  ).toBeGreaterThanOrEqual(2)
})

it('maps canonical host-local keys to registered project sections with mobile visibility parity', () => {
  const repo = {
    id: 'atlas',
    displayName: 'Atlas',
    path: '/projects/atlas',
    addedAt: 0,
    badgeColor: '',
    executionHostId: 'local' as const
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const [project] = buildProjectConversations({
    ...defaults,
    repos: [repo],
    history: [conversationHistory({ projectOwnerKey: 'repo:atlas' })],
    projectCatalog: {
      repos: [repo],
      projectOrderBy: 'manual',
      repoOrder: undefined,
      grouping: { projects: projection.projects, projectHostSetups: projection.setups }
    }
  })
  expect(project?.repo?.id).toBe('atlas')
  expect(project?.data).toHaveLength(1)
  expect(project?.visibilityKey).toBe(JSON.stringify(['local', 'project:repo:atlas']))
})
