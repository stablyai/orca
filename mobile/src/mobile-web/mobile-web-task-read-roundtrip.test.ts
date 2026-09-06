import { expect, it, vi } from 'vitest'
import { webHostTaskPreferenceOperations } from '../tasks/web-host-task-preference-operations'
import { webHostTaskDetailOperations } from '../tasks/web-host-task-detail-operations'
import { webHostTaskProjectReadOperations } from '../tasks/web-host-task-project-read-operations'
import { webHostTaskListOperations } from '../tasks/web-host-task-list-operations'
import { webHostTaskReadOperations } from '../tasks/web-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import {
  TASK_ROUNDTRIP_HOST_REPO_ID,
  taskRoundtripHostResponse
} from './mobile-web-task-roundtrip-host-fixtures'

it('round trips bounded task bootstrap reads through opaque repository authority', async () => {
  const sendRequest = vi.fn(async (method: string) => taskRoundtripHostResponse(method))
  const rpcClient = { sendRequest } as unknown as RpcClient
  let requestIndex = 0
  const { broker, client } = createMobileWebBridgeRoundtripFixture({
    grants: [
      taskGrant('bootstrap'),
      taskGrant('repositories'),
      taskGrant('linearContext'),
      taskGrant('resolveRepoSlug'),
      taskGrant('updateResume'),
      taskGrant('updateSettings'),
      taskGrant('listGitHub'),
      taskGrant('countGitHub'),
      taskGrant('listGitLab'),
      taskGrant('listGitLabTodos'),
      taskGrant('listLinear'),
      taskGrant('listGitHubLabels'),
      taskGrant('listGitHubAssignableUsers'),
      taskGrant('loadGitHubDetail'),
      taskGrant('loadGitLabDetail'),
      taskGrant('loadLinearDetail'),
      taskGrant('listProjects'),
      taskGrant('listProjectViews'),
      taskGrant('resolveProjectRef'),
      taskGrant('projectTable'),
      taskGrant('projectItemDetail'),
      taskGrant('projectItemLabels'),
      taskGrant('projectItemAssignableUsers'),
      taskGrant('projectIssueTypes')
    ],
    rpcClient,
    createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22),
    terminalClientId: 'device-token'
  })
  const operations = webHostTaskReadOperations(client)
  const lists = webHostTaskListOperations(client)
  const details = webHostTaskDetailOperations(client)
  const projects = webHostTaskProjectReadOperations(client)
  const preferences = webHostTaskPreferenceOperations(client)

  const repositories = await operations.listRepositories()
  expect(repositories).toEqual([
    expect.objectContaining({
      id: expect.stringMatching(/^repo_/),
      displayName: 'Orca',
      path: '/private/host/orca'
    })
  ])
  expect(JSON.stringify(repositories)).not.toContain('privateMetadata')
  const pageRepoId = repositories[0]!.id
  await expect(operations.bootstrap()).resolves.toMatchObject({
    supported: true,
    settings: {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude'],
      defaultRepoSelection: [pageRepoId],
      visibleTaskProviders: ['github', 'linear']
    },
    trustedOrcaHooks: {
      [pageRepoId]: { setup: { contentHash: 'f'.repeat(64), approvedAt: 10 } }
    },
    gitLabInstalled: true,
    linearStatus: { connected: true }
  })
  await expect(operations.loadLinearContext()).resolves.toMatchObject({
    status: { selectedWorkspaceId: 'linear-workspace' },
    teams: [{ id: 'team-1', name: 'Mobile', key: 'MOB' }]
  })
  await expect(operations.resolveGitHubRepoSlug(pageRepoId)).resolves.toEqual({
    owner: 'stablyai',
    repo: 'orca',
    host: 'github.com'
  })
  await preferences.updateResume({ githubMode: 'project' })
  await preferences.updateSettings({ defaultRepoSelection: [pageRepoId] })
  const gitHubPage = await lists.listGitHub({
    repoId: pageRepoId,
    limit: 36,
    query: 'is:open'
  })
  expect(gitHubPage.items[0]).toMatchObject({ number: 7, title: 'Typed tasks' })
  expect(gitHubPage.sources).toEqual({ issues: null, prs: null, upstreamCandidate: null })
  expect(gitHubPage.errors).toEqual({
    issues: { message: 'Issue source unavailable' }
  })
  await expect(lists.countGitHub({ repoId: pageRepoId, query: 'is:open' })).resolves.toBe(2)
  const gitLabPage = await lists.listGitLab({
    repoId: pageRepoId,
    state: 'opened',
    page: 1,
    perPage: 50
  })
  expect(gitLabPage.items[0]).toMatchObject({
    number: 9,
    title: 'GitLab task',
    targetId: expect.stringMatching(/^task_target_/)
  })
  expect(JSON.stringify(gitLabPage)).not.toContain('private/upstream')
  await expect(lists.listGitLabTodos(pageRepoId)).resolves.toMatchObject([
    { id: 11, targetTitle: 'Review todo' }
  ])
  const linearItems = await lists.listLinear({
    filter: 'assigned',
    limit: 50,
    workspaceId: 'linear-workspace'
  })
  expect(linearItems).toMatchObject([{ identifier: 'MOB-12', title: 'Linear task' }])
  expect(linearItems[0]?.targetId).toMatch(/^task_target_/)
  await expect(details.listGitHubLabels(pageRepoId)).resolves.toEqual(['mobile'])
  await expect(details.listGitHubAssignableUsers(pageRepoId)).resolves.toEqual([
    { login: 'octo', name: 'Octo', avatarUrl: null }
  ])
  await expect(
    details.loadGitHub({ repoId: pageRepoId, number: 7, type: 'issue' })
  ).resolves.toMatchObject({ body: 'GitHub details', labels: ['mobile'] })
  await expect(
    details.loadGitLab({
      repoId: pageRepoId,
      number: 9,
      type: 'issue',
      targetId: gitLabPage.items[0]!.targetId
    })
  ).resolves.toMatchObject({ body: 'GitLab details', labels: ['mobile'] })
  await expect(
    details.loadLinear({
      issueId: 'redacted-linear',
      workspaceId: 'redacted-workspace',
      targetId: linearItems[0]!.targetId
    })
  ).resolves.toMatchObject({
    issue: { identifier: 'MOB-12', description: 'Linear details' },
    comments: [{ body: 'Linear comment' }]
  })
  await expect(projects.listAccessible('github.com')).resolves.toMatchObject({
    projects: [{ owner: 'stablyai', number: 3, title: 'Mobile' }],
    partialFailures: []
  })
  await expect(
    projects.listViews({
      owner: 'stablyai',
      ownerType: 'organization',
      number: 3,
      host: 'github.com'
    })
  ).resolves.toEqual([{ id: 'view-node', number: 1, name: 'Roadmap', layout: 'TABLE_LAYOUT' }])
  await expect(
    projects.resolveRef({
      input: 'https://github.com/orgs/stablyai/projects/3/views/1',
      host: 'github.com'
    })
  ).resolves.toMatchObject({ owner: 'stablyai', number: 3, viewNumber: 1 })
  const project = {
    owner: 'stablyai',
    ownerType: 'organization' as const,
    number: 3,
    host: 'github.com'
  }
  const projectTable = await projects.loadTable({ ...project, viewId: 'view-node' })
  expect(projectTable.totalCount).toBe(2)
  expect(projectTable.rows[0]).toMatchObject({
    id: 'project-item',
    content: { title: 'Typed tasks' }
  })
  const slug = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
  await expect(
    projects.loadItemDetail({ ...slug, number: 7, type: 'issue' })
  ).resolves.toMatchObject({ body: 'Project item details', labels: ['project'] })
  await expect(projects.listItemLabels(slug)).resolves.toEqual(['project'])
  await expect(projects.listItemAssignableUsers(slug)).resolves.toEqual([
    { login: 'octo', name: 'Octo', avatarUrl: null }
  ])
  await expect(projects.listIssueTypes(slug)).resolves.toEqual([
    { id: 'type-1', name: 'Bug', color: 'RED', description: 'Defect' }
  ])
  expect(sendRequest).toHaveBeenCalledWith(
    'github.repoSlug',
    {
      repo: `id:${TASK_ROUNDTRIP_HOST_REPO_ID}`
    },
    {
      timeoutMs: 30_000
    }
  )
  expect(sendRequest).toHaveBeenCalledWith('ui.set', {
    taskResumeState: { githubMode: 'project' }
  })
  expect(sendRequest).toHaveBeenCalledWith('settings.update', {
    defaultRepoSelection: [TASK_ROUNDTRIP_HOST_REPO_ID]
  })
  expect(sendRequest).toHaveBeenCalledWith(
    'gitlab.workItemDetails',
    {
      repo: `id:${TASK_ROUNDTRIP_HOST_REPO_ID}`,
      iid: 9,
      type: 'issue',
      projectRef: { host: 'gitlab.example.com', path: 'private/upstream' }
    },
    { timeoutMs: 30_000 }
  )
  broker.replaceClient(rpcClient)
  await expect(
    details.loadGitLab({
      repoId: pageRepoId,
      number: 9,
      type: 'issue',
      targetId: gitLabPage.items[0]!.targetId
    })
  ).rejects.toThrow('not_found')
  expect(JSON.stringify(client)).not.toContain(TASK_ROUNDTRIP_HOST_REPO_ID)
})

function taskGrant(
  operation:
    | 'bootstrap'
    | 'repositories'
    | 'linearContext'
    | 'resolveRepoSlug'
    | 'updateResume'
    | 'updateSettings'
    | 'listGitHub'
    | 'countGitHub'
    | 'listGitLab'
    | 'listGitLabTodos'
    | 'listLinear'
    | 'listGitHubLabels'
    | 'listGitHubAssignableUsers'
    | 'loadGitHubDetail'
    | 'loadGitLabDetail'
    | 'loadLinearDetail'
    | 'listProjects'
    | 'listProjectViews'
    | 'resolveProjectRef'
    | 'projectTable'
    | 'projectItemDetail'
    | 'projectItemLabels'
    | 'projectItemAssignableUsers'
    | 'projectIssueTypes'
) {
  return {
    capability: 'task' as const,
    operation,
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 192 * 1024,
      maxConcurrent: 4,
      rateCapacity: 20,
      rateRefillPerSecond: 20
    }
  }
}
