import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { executeMobileWebSourceControlOperation } from './mobile-web-source-control-operations'
import { executeMobileWebSourceControlSyncOperation } from './mobile-web-source-control-sync-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HEAD = 'a'.repeat(40)
const HOST_WORKSPACE_A = 'repo-a::/workspace-a'
const HOST_WORKSPACE_B = 'repo-b::/workspace-b'

describe('mobile web cross-workspace mutation races', () => {
  it('rejects staging after the target workspace disappears during preflight', async () => {
    const harness = raceHarness()
    const status = deferredRpcResult()
    const client = clientWithDeferredStatus(status)
    const pending = executeMobileWebSourceControlOperation({
      operation: 'stage',
      payload: {
        workspaceId: harness.pageWorkspaceA,
        expectedHead: HEAD,
        entries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'unstaged' }]
      },
      client,
      workspaceAuthority: harness.authority
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await waitForCall(client, 'git.status')
    harness.removeWorkspaceA()
    status.resolve(success(statusWithEntry('unstaged')))

    await rejection
    expect(callsFor(client, 'git.stage')).toHaveLength(0)
  })

  it('rejects commit after the target workspace disappears during preflight', async () => {
    const harness = raceHarness()
    const status = deferredRpcResult()
    const client = clientWithDeferredStatus(status)
    const pending = executeMobileWebSourceControlOperation({
      operation: 'commit',
      payload: {
        workspaceId: harness.pageWorkspaceA,
        expectedHead: HEAD,
        stagedEntries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'staged' }],
        message: 'feat: guarded commit'
      },
      client,
      workspaceAuthority: harness.authority
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await waitForCall(client, 'git.status')
    harness.removeWorkspaceA()
    status.resolve(success(statusWithEntry('staged')))

    await rejection
    expect(callsFor(client, 'git.commit')).toHaveLength(0)
  })

  it('rejects fetch after the target workspace disappears during preflight', async () => {
    const harness = raceHarness()
    const status = deferredRpcResult()
    const client = clientWithDeferredStatus(status)
    const pending = executeMobileWebSourceControlSyncOperation({
      operation: 'fetch',
      payload: {
        workspaceId: harness.pageWorkspaceA,
        expectedHead: HEAD,
        expectedBranch: 'main'
      },
      client,
      workspaceAuthority: harness.authority
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await waitForCall(client, 'git.status')
    harness.removeWorkspaceA()
    status.resolve(success(repositoryStatus()))

    await rejection
    expect(callsFor(client, 'git.fetch')).toHaveLength(0)
  })

  it('rejects provider mutation after final identity preflight loses its workspace', async () => {
    const harness = raceHarness()
    const finalStatus = deferredRpcResult()
    let statusReads = 0
    const sendRequest = vi.fn((method: string) => {
      if (method === 'git.status') {
        statusReads += 1
        return statusReads === 1 ? Promise.resolve(success(reviewStatus())) : finalStatus.promise
      }
      if (method === 'hostedReview.forBranch') {
        return Promise.resolve(success(hostedReview()))
      }
      if (method === 'github.workItemDetails') {
        return Promise.resolve(success(reviewDetails()))
      }
      if (method === 'github.addIssueComment') {
        return Promise.resolve(success({ ok: true, comment: { id: 1 } }))
      }
      return Promise.resolve({ ok: false, error: { code: 'unexpected' } })
    })
    const client = { sendRequest } as unknown as RpcClient & {
      sendRequest: ReturnType<typeof vi.fn>
    }
    const pending = executeMobileWebProviderOperation({
      operation: 'mutateReview',
      payload: {
        workspaceId: harness.pageWorkspaceA,
        expectedHead: HEAD,
        expectedBranch: 'feature/review',
        provider: 'github',
        reviewNumber: 17,
        action: 'comment',
        body: 'Do not cross workspace authority.'
      },
      client,
      workspaceAuthority: harness.authority
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await vi.waitFor(() => expect(callsFor(client, 'git.status')).toHaveLength(2))
    harness.removeWorkspaceA()
    finalStatus.resolve(success(reviewStatus()))

    await rejection
    expect(callsFor(client, 'github.addIssueComment')).toHaveLength(0)
  })

  it('rejects review management when reviewer preflight loses its workspace', async () => {
    const harness = raceHarness()
    const assignable = deferredRpcResult()
    const sendRequest = vi.fn((method: string) => {
      if (method === 'git.status') {
        return Promise.resolve(success(reviewStatus()))
      }
      if (method === 'hostedReview.forBranch') {
        return Promise.resolve(success(hostedReview()))
      }
      if (method === 'github.workItemDetails') {
        return Promise.resolve(success(reviewDetails()))
      }
      if (method === 'github.listAssignableUsers') {
        return assignable.promise
      }
      if (method === 'github.requestPRReviewers') {
        return Promise.resolve(success({ ok: true }))
      }
      return Promise.resolve({ ok: false, error: { code: 'unexpected' } })
    })
    const client = { sendRequest } as unknown as RpcClient & {
      sendRequest: ReturnType<typeof vi.fn>
    }
    const pending = executeMobileWebProviderOperation({
      operation: 'manageReview',
      payload: {
        workspaceId: harness.pageWorkspaceA,
        expectedHead: HEAD,
        expectedBranch: 'feature/review',
        provider: 'github',
        reviewNumber: 17,
        action: 'requestReviewers',
        reviewers: ['ada']
      },
      client,
      workspaceAuthority: harness.authority
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await vi.waitFor(() => expect(callsFor(client, 'github.listAssignableUsers')).toHaveLength(1))
    harness.removeWorkspaceA()
    assignable.resolve(success([{ login: 'ada' }]))

    await rejection
    expect(callsFor(client, 'github.requestPRReviewers')).toHaveLength(0)
  })
})

function raceHarness() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
  authority.synchronize([
    { workspaceId: HOST_WORKSPACE_A, repoId: 'repo-a' },
    { workspaceId: HOST_WORKSPACE_B, repoId: 'repo-b' }
  ])
  return {
    authority,
    pageWorkspaceA: authority.pageWorkspaceId(HOST_WORKSPACE_A),
    removeWorkspaceA: () =>
      authority.synchronize([{ workspaceId: HOST_WORKSPACE_B, repoId: 'repo-b' }])
  }
}

function clientWithDeferredStatus(status: ReturnType<typeof deferredRpcResult>) {
  const sendRequest = vi.fn((method: string) => {
    if (method === 'git.status') {
      return status.promise
    }
    return Promise.resolve(success({ ok: true }))
  })
  return { sendRequest } as unknown as RpcClient & {
    sendRequest: ReturnType<typeof vi.fn>
  }
}

function deferredRpcResult() {
  let resolve = (_result: ReturnType<typeof success>): void => {}
  const promise = new Promise<ReturnType<typeof success>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function success(result: unknown) {
  return { ok: true as const, result }
}

function repositoryStatus() {
  return { head: HEAD, branch: 'main', conflictOperation: 'unknown' }
}

function reviewStatus() {
  return { head: HEAD, branch: 'feature/review', conflictOperation: 'unknown' }
}

function statusWithEntry(area: 'staged' | 'unstaged') {
  return {
    ...repositoryStatus(),
    entries: [{ path: 'src/app.ts', status: 'modified', area }]
  }
}

function hostedReview() {
  return {
    provider: 'github',
    number: 17,
    title: 'Race review',
    state: 'open',
    status: 'success',
    updatedAt: '2026-07-28T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    headSha: HEAD
  }
}

function reviewDetails() {
  return {
    item: {
      id: 'PR_17',
      number: 17,
      type: 'pr',
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    },
    body: '',
    comments: []
  }
}

async function waitForCall(
  client: { sendRequest: ReturnType<typeof vi.fn> },
  method: string
): Promise<void> {
  await vi.waitFor(() => expect(callsFor(client, method)).toHaveLength(1))
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
