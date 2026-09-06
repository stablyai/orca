import { expect, it, vi } from 'vitest'
import { webHostTaskProjectFileOperations } from '../tasks/web-host-task-project-file-operations'
import { webHostTaskProjectMutationOperations } from '../tasks/web-host-task-project-mutation-operations'
import { webHostTaskProjectReadOperations } from '../tasks/web-host-task-project-read-operations'
import { webHostTaskReadOperations } from '../tasks/web-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { taskRoundtripHostResponse } from './mobile-web-task-roundtrip-host-fixtures'

const CONTEXT = {
  shellSessionId: 'M'.repeat(43),
  buildId: 'b'.repeat(64)
}

it('revalidates opaque GitHub Project mutation targets before every write', async () => {
  const sendRequest = vi.fn(async (method: string) => taskRoundtripHostResponse(method))
  const rpcClient = { sendRequest } as unknown as RpcClient
  let requestIndex = 0
  const { broker, client } = createMobileWebBridgeRoundtripFixture({
    context: CONTEXT,
    grants: [
      taskGrant('repositories'),
      taskGrant('projectTable'),
      taskGrant('updateProjectItem'),
      taskGrant('addProjectComment'),
      taskGrant('updateProjectComment'),
      taskGrant('deleteProjectComment'),
      taskGrant('updateProjectMetadata'),
      taskGrant('updateProjectField'),
      taskGrant('updateProjectIssueType'),
      taskGrant('resolveProjectReviewThread'),
      taskGrant('replyProjectReviewComment'),
      taskGrant('addProjectConversationComment'),
      taskGrant('requestProjectReviewers'),
      taskGrant('rerunProjectChecks'),
      taskGrant('mergeProjectPullRequest'),
      taskGrant('refreshProjectChecks'),
      taskGrant('setProjectFileViewed'),
      taskGrant('loadProjectFileContents'),
      taskGrant('addProjectInlineComment')
    ],
    rpcClient,
    createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22),
    terminalClientId: 'device-token',
    randomBytes: (length) => new Uint8Array(length).fill(3)
  })

  const pageRepoId = (await webHostTaskReadOperations(client).listRepositories())[0]!.id
  const table = await webHostTaskProjectReadOperations(client).loadTable({
    owner: 'stablyai',
    ownerType: 'organization',
    number: 3,
    host: 'github.com',
    viewId: 'view-node'
  })
  const targetId = table.rows[0]?.targetId
  expect(targetId).toMatch(/^task_target_/)
  if (!targetId) {
    throw new Error('Missing project target authority')
  }
  const target = {
    targetId,
    owner: 'redacted',
    repo: 'redacted',
    host: 'redacted',
    number: 999,
    type: 'issue' as const
  }
  const operations = webHostTaskProjectMutationOperations(client)

  await operations.updateItem(target, { title: 'Updated' })
  await expect(operations.addComment(target, 'Comment')).resolves.toMatchObject({
    body: 'Added from hosted Tasks'
  })
  await operations.updateComment(target, 22, 'Edited')
  await operations.deleteComment(target, 22)
  await operations.updateMetadata(target, { addLabels: ['mobile'] })
  await operations.updateField(
    { ...target, projectId: 'redacted', itemId: 'redacted' },
    'field-note',
    { kind: 'text', text: 'Ready' }
  )
  await operations.updateIssueType(target, 'type-1')
  const prTargetId = table.rows[1]?.targetId
  expect(prTargetId).toMatch(/^task_target_/)
  if (!prTargetId) {
    throw new Error('Missing project PR target authority')
  }
  const prTarget = { ...target, targetId: prTargetId, number: 998, type: 'pr' as const }
  const fileOperations = webHostTaskProjectFileOperations(client)
  await operations.resolveReviewThread(prTarget, pageRepoId, 'thread-1', true)
  await operations.replyReviewComment(prTarget, pageRepoId, {
    commentId: 23,
    body: 'Reply',
    threadId: 'thread-1',
    path: 'src/file.ts',
    line: 7
  })
  await operations.addConversationComment(prTarget, pageRepoId, 'Conversation')
  await operations.requestReviewers(prTarget, pageRepoId, ['octo'])
  await operations.rerunChecks(prTarget, pageRepoId, {
    headSha: 'a'.repeat(40),
    failedOnly: true
  })
  await operations.merge(prTarget, pageRepoId, 'squash')
  await expect(fileOperations.refreshChecks(prTarget, pageRepoId, 'a'.repeat(40))).resolves.toEqual(
    [
      {
        name: 'Mobile checks',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/stablyai/orca/actions/runs/1'
      }
    ]
  )
  await expect(
    fileOperations.setFileViewed(prTarget, pageRepoId, {
      pullRequestId: 'pull-request-node',
      path: 'src/file.ts',
      viewed: true
    })
  ).resolves.toBeUndefined()
  await expect(
    fileOperations.loadFileContents(prTarget, pageRepoId, {
      path: 'src/file.ts',
      status: 'modified',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40)
    })
  ).resolves.toEqual({
    original: 'before\n',
    modified: 'after\n',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  await expect(
    fileOperations.addInlineComment(prTarget, pageRepoId, {
      commitId: 'a'.repeat(40),
      path: 'src/file.ts',
      line: 7,
      body: 'Inline comment'
    })
  ).resolves.toMatchObject({ id: 24, body: 'Inline comment' })

  expect(sendRequest).toHaveBeenCalledWith(
    'github.project.updateIssueBySlug',
    {
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com',
      number: 7,
      updates: { title: 'Updated' }
    },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.project.updateItemField',
    {
      projectId: 'project-node',
      host: 'github.com',
      itemId: 'project-item',
      fieldId: 'field-note',
      value: { kind: 'text', text: 'Ready' }
    },
    { timeoutMs: 30_000 }
  )
  expect(
    sendRequest.mock.calls.filter(([method]) => method === 'github.project.viewTable')
  ).toHaveLength(18)
  expect(sendRequest).toHaveBeenCalledWith(
    'github.mergePR',
    {
      repo: `id:host-repo-private`,
      prNumber: 8,
      method: 'squash',
      prRepo: { owner: 'stablyai', repo: 'orca', host: 'github.com' }
    },
    // A merge routinely outruns the 30s default.
    { timeoutMs: 60_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.prChecks',
    {
      repo: 'id:host-repo-private',
      prRepo: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      prNumber: 8,
      headSha: 'a'.repeat(40),
      noCache: true
    },
    { timeoutMs: 30_000 }
  )
  expect(sendRequest).toHaveBeenCalledWith(
    'github.prFileContents',
    {
      repo: 'id:host-repo-private',
      prRepo: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      prNumber: 8,
      path: 'src/file.ts',
      status: 'modified',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40)
    },
    { timeoutMs: 30_000 }
  )
  const desktopRequests = JSON.stringify(sendRequest.mock.calls)
  expect(desktopRequests).not.toContain('redacted')
  expect(desktopRequests).not.toContain(targetId)
  expect(desktopRequests).not.toContain(prTargetId)
  expect(desktopRequests).not.toContain(pageRepoId)

  broker.replaceClient(rpcClient)
  await expect(operations.updateItem(target, { title: 'Revoked' })).rejects.toThrow('not_found')
})

function taskGrant(operation: string) {
  return {
    capability: 'task' as const,
    operation,
    limits: {
      maxRequestBytes: 72 * 1024,
      maxResponseBytes: 192 * 1024,
      maxConcurrent: 4,
      rateCapacity: 20,
      rateRefillPerSecond: 20
    }
  }
}
