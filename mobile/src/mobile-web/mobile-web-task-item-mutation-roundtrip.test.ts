import { expect, it, vi } from 'vitest'
import { webHostTaskItemFileOperations } from '../tasks/web-host-task-item-file-operations'
import { webHostTaskItemMutationOperations } from '../tasks/web-host-task-item-mutation-operations'
import { webHostTaskItemReviewOperations } from '../tasks/web-host-task-item-review-operations'
import { webHostTaskLinearOperations } from '../tasks/web-host-task-linear-operations'
import { webHostTaskProviderWriteOperations } from '../tasks/web-host-task-provider-write-operations'
import { webHostTaskListOperations } from '../tasks/web-host-task-list-operations'
import { webHostTaskReadOperations } from '../tasks/web-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { taskRoundtripHostResponse } from './mobile-web-task-roundtrip-host-fixtures'

const CONTEXT = {
  shellSessionId: 'I'.repeat(43),
  buildId: 'c'.repeat(64)
}

it('revalidates opaque hosted task targets before provider writes', async () => {
  const sendRequest = vi.fn(async (method: string) => taskRoundtripHostResponse(method))
  const rpcClient = { sendRequest } as unknown as RpcClient
  let requestIndex = 0
  const { broker, client } = createMobileWebBridgeRoundtripFixture({
    context: CONTEXT,
    grants: [
      taskGrant('repositories'),
      taskGrant('listGitHub'),
      taskGrant('listGitLab'),
      taskGrant('updateHostedTaskStatus'),
      taskGrant('updateHostedTaskMetadata'),
      taskGrant('addHostedTaskComment'),
      taskGrant('requestHostedTaskReviewers'),
      taskGrant('resolveHostedTaskReviewThread'),
      taskGrant('replyHostedTaskReviewComment'),
      taskGrant('mergeHostedTaskReview'),
      taskGrant('refreshHostedTaskChecks'),
      taskGrant('rerunHostedTaskChecks'),
      taskGrant('setHostedTaskFileViewed'),
      taskGrant('loadHostedTaskFileContents'),
      taskGrant('addHostedTaskInlineComment'),
      taskGrant('listLinear'),
      taskGrant('connectLinear'),
      taskGrant('listLinearTeams'),
      taskGrant('listLinearTeamStates'),
      taskGrant('selectLinearWorkspace'),
      taskGrant('updateLinearIssueState'),
      taskGrant('addLinearIssueComment'),
      taskGrant('loadLinearIssue'),
      taskGrant('createLinearSubIssue'),
      taskGrant('createLinearIssue'),
      taskGrant('createProviderIssue'),
      taskGrant('updateIssueSource')
    ],
    rpcClient,
    createRequestId: () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[requestIndex++]!.repeat(22),
    terminalClientId: 'device-token',
    randomBytes: (length) => new Uint8Array(length).fill(4)
  })

  const repoId = (await webHostTaskReadOperations(client).listRepositories())[0]!.id
  const lists = webHostTaskListOperations(client)
  const gitHubItems = (await lists.listGitHub({ repoId, query: 'is:issue', limit: 20 })).items
  const gitLabItems = (await lists.listGitLab({ repoId, state: 'opened', page: 1, perPage: 20 }))
    .items
  const gitHubItem = gitHubItems[0]!
  const gitHubPullRequest = gitHubItems[1]!
  const gitLabItem = gitLabItems[0]!
  const gitLabMergeRequest = gitLabItems[1]!
  const linearItem = (
    await lists.listLinear({
      filter: 'assigned',
      limit: 50,
      workspaceId: 'linear-workspace'
    })
  )[0]!
  expect(gitHubItem.targetId).toMatch(/^task_target_/)
  expect(gitLabItem.targetId).toMatch(/^task_target_/)
  expect(JSON.stringify(gitLabItem)).not.toContain('private/upstream')

  const operations = webHostTaskItemMutationOperations(client)
  const gitHubTarget = {
    provider: 'github' as const,
    repoId: 'redacted',
    number: 999,
    type: 'pr' as const,
    targetId: gitHubItem.targetId
  }
  const gitLabTarget = {
    provider: 'gitlab' as const,
    repoId: 'redacted',
    number: 998,
    type: 'mr' as const,
    projectRef: { host: 'redacted', path: 'redacted' },
    targetId: gitLabItem.targetId
  }
  await operations.setClosed(gitHubTarget, true)
  await operations.updateMetadata(gitLabTarget, {
    title: 'Updated GitLab task',
    addLabels: ['mobile']
  })
  const reviewOperations = webHostTaskItemReviewOperations(client)
  const pullRequestTarget = {
    ...gitHubTarget,
    type: 'issue' as const,
    targetId: gitHubPullRequest.targetId
  }
  const mergeRequestTarget = {
    ...gitLabTarget,
    type: 'issue' as const,
    targetId: gitLabMergeRequest.targetId
  }
  await expect(reviewOperations.addComment(gitHubTarget, 'Hosted comment')).resolves.toBeUndefined()
  await reviewOperations.requestReviewers(pullRequestTarget, ['octo'])
  await reviewOperations.resolveThread(pullRequestTarget, 'thread-1', true)
  await reviewOperations.replyReviewComment(pullRequestTarget, {
    commentId: 23,
    body: 'Reply',
    threadId: 'thread-1',
    path: 'src/file.ts',
    line: 7
  })
  await reviewOperations.merge(pullRequestTarget, 'squash')
  await reviewOperations.merge(mergeRequestTarget, 'merge')
  const fileOperations = webHostTaskItemFileOperations(client)
  await expect(fileOperations.refreshChecks(pullRequestTarget, 'redacted-head')).resolves.toEqual([
    {
      name: 'Mobile checks',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/stablyai/orca/actions/runs/1'
    }
  ])
  await fileOperations.rerunChecks(pullRequestTarget, 'redacted-head', true)
  await fileOperations.setFileViewed(pullRequestTarget, {
    pullRequestId: 'redacted-pull-request',
    path: 'src/file.ts',
    viewed: true
  })
  await expect(
    fileOperations.loadFileContents(pullRequestTarget, {
      path: 'src/file.ts',
      oldPath: 'redacted-old-path',
      status: 'added',
      headSha: 'redacted-head',
      baseSha: 'redacted-base'
    })
  ).resolves.toEqual({
    original: 'before\n',
    modified: 'after\n',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  await expect(
    fileOperations.addInlineComment(pullRequestTarget, {
      commitId: 'redacted-head',
      path: 'src/file.ts',
      line: 7,
      body: 'Inline comment'
    })
  ).resolves.toMatchObject({ id: 24, body: 'Inline comment' })
  const linearOperations = webHostTaskLinearOperations(client)
  const linearTarget = {
    issueId: 'redacted-linear',
    workspaceId: 'redacted-linear-workspace',
    teamId: 'redacted-linear-team',
    targetId: linearItem.targetId
  }
  await linearOperations.connect('linear-secret')
  const teams = await linearOperations.listTeams()
  await linearOperations.selectWorkspace('linear-workspace')
  await expect(linearOperations.teamStates(linearTarget)).resolves.toMatchObject([
    { id: 'state-started', name: 'In Progress' }
  ])
  await linearOperations.updateState(linearTarget, 'state-started')
  await expect(linearOperations.addComment(linearTarget, 'Linear comment')).resolves.toBe(
    'linear-comment-new'
  )
  await expect(linearOperations.loadIssue(linearTarget)).resolves.toMatchObject({
    identifier: 'MOB-12'
  })
  await expect(linearOperations.createSubIssue(linearTarget, 'Sub-issue')).resolves.toMatchObject({
    identifier: 'MOB-13',
    targetId: expect.stringMatching(/^task_target_/)
  })
  await expect(
    linearOperations.createIssue({
      team: teams[0]!,
      title: 'Top-level issue',
      description: 'Description'
    })
  ).resolves.toMatchObject({
    identifier: 'MOB-13',
    targetId: expect.stringMatching(/^task_target_/)
  })
  const providerOperations = webHostTaskProviderWriteOperations(client)
  await expect(
    providerOperations.createIssue({
      provider: 'github',
      repoId,
      title: 'Hosted issue',
      body: 'Issue body'
    })
  ).resolves.toMatchObject({ number: 14 })
  await providerOperations.updateIssueSource(repoId, 'upstream')

  expect(sendRequest).toHaveBeenCalledWith(
    'github.workItemDetails',
    { repo: 'id:host-repo-private', number: 7, type: 'issue' },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.requestPRReviewers',
    { repo: 'id:host-repo-private', prNumber: 8, reviewers: ['octo'] },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.mergePR',
    { repo: 'id:host-repo-private', prNumber: 8, method: 'squash' },
    { timeoutMs: 60_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'gitlab.mergeMR',
    {
      repo: 'id:host-repo-private',
      iid: 10,
      method: 'merge',
      projectRef: { host: 'gitlab.example.com', path: 'private/upstream' }
    },
    { timeoutMs: 60_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.prChecks',
    {
      repo: 'id:host-repo-private',
      prNumber: 8,
      headSha: 'a'.repeat(40),
      noCache: true
    },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.rerunPRChecks',
    {
      repo: 'id:host-repo-private',
      prNumber: 8,
      headSha: 'a'.repeat(40),
      failedOnly: true
    },
    { timeoutMs: 60_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.setPRFileViewed',
    {
      repo: 'id:host-repo-private',
      pullRequestId: 'pull-request-node',
      path: 'src/file.ts',
      viewed: true
    },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.prFileContents',
    {
      repo: 'id:host-repo-private',
      prNumber: 8,
      path: 'src/file.ts',
      status: 'modified',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40)
    },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.addPRReviewComment',
    {
      repo: 'id:host-repo-private',
      prNumber: 8,
      commitId: 'a'.repeat(40),
      path: 'src/file.ts',
      line: 7,
      body: 'Inline comment'
    },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith('github.updateIssue', {
    repo: 'id:host-repo-private',
    number: 7,
    updates: { state: 'closed' }
  })
  expect(sendRequest).toHaveBeenCalledWith(
    'gitlab.updateIssue',
    {
      repo: 'id:host-repo-private',
      number: 9,
      updates: { title: 'Updated GitLab task', addLabels: ['mobile'] },
      projectRef: { host: 'gitlab.example.com', path: 'private/upstream' }
    },
    { timeoutMs: 30_000 }
  )
  const desktopRequests = JSON.stringify(sendRequest.mock.calls)
  expect(desktopRequests).not.toContain('redacted')
  expect(desktopRequests).not.toContain(gitHubItem.targetId)
  expect(desktopRequests).not.toContain(gitHubPullRequest.targetId)
  expect(desktopRequests).not.toContain(gitLabItem.targetId)
  expect(desktopRequests).not.toContain(gitLabMergeRequest.targetId)
  expect(desktopRequests).not.toContain('redacted-head')
  expect(desktopRequests).not.toContain('redacted-base')
  expect(desktopRequests).not.toContain('redacted-pull-request')
  expect(desktopRequests).not.toContain('redacted-old-path')
  expect(desktopRequests).not.toContain('redacted-linear-workspace')
  expect(desktopRequests).not.toContain('redacted-linear-team')
  expect(desktopRequests).not.toContain('redacted-linear')
  expect(desktopRequests).not.toContain(repoId)

  broker.replaceClient(rpcClient)
  await expect(operations.setClosed(gitHubTarget, false)).rejects.toThrow('not_found')
})

function taskGrant(operation: string) {
  return {
    capability: 'task' as const,
    operation,
    limits: {
      maxRequestBytes: 72 * 1024,
      maxResponseBytes: 192 * 1024,
      maxConcurrent: 4,
      rateCapacity: 100,
      rateRefillPerSecond: 100
    }
  }
}
