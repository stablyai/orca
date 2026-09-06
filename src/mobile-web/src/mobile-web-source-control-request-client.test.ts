import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

describe('mobile web source-control request client', () => {
  it('sends explicit typed status and diff requests and validates their identities', async () => {
    const harness = createHarness()
    const status = harness.client.sourceControlStatus({ workspaceId: 'workspace-1', limit: 10 })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        branch: 'main',
        conflictOperation: 'unknown',
        entries: [],
        totalCount: 0,
        truncated: false
      })
    )
    await expect(status).resolves.toMatchObject({ workspaceId: 'workspace-1', entries: [] })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'status',
      payload: { workspaceId: 'workspace-1', limit: 10 }
    })

    const diff = harness.client.sourceControlDiff({
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
      area: 'unstaged',
      offset: 0,
      limit: 20
    })
    harness.client.receive(
      response('B'.repeat(22), {
        workspaceId: 'workspace-2',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        kind: 'binary'
      })
    )
    await expect(diff).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('rejects raw host diff content even when the shell labels it successful', async () => {
    const harness = createHarness()
    const diff = harness.client.sourceControlDiff({
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
      area: 'unstaged',
      offset: 0,
      limit: 20
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        kind: 'text',
        originalContent: 'secret',
        modifiedContent: 'secret changed'
      })
    )

    await expect(diff).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('sends bounded branch and history reads with workspace identity checks', async () => {
    const harness = createHarness()
    const branches = harness.client.sourceControlBranches({ workspaceId: 'workspace-1' })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'branches',
      payload: { workspaceId: 'workspace-1' }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        current: 'main',
        branches: ['main', 'feature/mobile'],
        totalCount: 2,
        truncated: false
      })
    )
    await expect(branches).resolves.toMatchObject({
      current: 'main',
      branches: ['main', 'feature/mobile']
    })

    const history = harness.client.sourceControlHistory({
      workspaceId: 'workspace-1',
      limit: 50,
      baseRef: 'main'
    })
    expect(harness.messages[1]).toMatchObject({
      capability: 'sourceControl',
      operation: 'history',
      payload: { workspaceId: 'workspace-1', limit: 50, baseRef: 'main' }
    })
    harness.client.receive(
      response('B'.repeat(22), {
        workspaceId: 'workspace-1',
        items: [
          {
            id: 'a'.repeat(40),
            parentIds: [],
            displayId: 'aaaaaaa',
            subject: 'feat: history',
            message: 'feat: history',
            references: []
          }
        ],
        hasIncomingChanges: false,
        hasOutgoingChanges: true,
        hasMore: false,
        limit: 50
      })
    )
    await expect(history).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      items: [{ subject: 'feat: history' }]
    })
  })

  it('rejects mismatched branch and commit comparison identities', async () => {
    const branchHarness = createHarness()
    const branch = branchHarness.client.sourceControlBranchCompare({
      workspaceId: 'workspace-1',
      baseRef: 'main',
      offset: 0,
      limit: 128
    })
    branchHarness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        baseRef: 'other',
        compareRef: 'HEAD',
        baseOid: 'a'.repeat(40),
        headOid: 'b'.repeat(40),
        mergeBase: 'a'.repeat(40),
        changedFiles: 0,
        status: 'ready',
        revision: 'c'.repeat(64),
        offset: 0,
        totalEntries: 0,
        entries: [],
        nextOffset: null,
        truncated: false
      })
    )
    await expect(branch).rejects.toMatchObject({ code: 'invalid_message', retryable: false })

    const commitHarness = createHarness()
    const commit = commitHarness.client.sourceControlCommitCompare({
      workspaceId: 'workspace-1',
      commitId: 'a'.repeat(40)
    })
    commitHarness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        commitId: 'b'.repeat(40),
        commitOid: 'b'.repeat(40),
        parentOid: null,
        compareRef: 'bbbbbbb',
        baseRef: 'empty tree',
        changedFiles: 0,
        status: 'ready',
        entries: [],
        truncated: false
      })
    )
    await expect(commit).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('sends bounded mutation snapshots and verifies the result identity', async () => {
    const harness = createHarness()
    const stage = harness.client.sourceControlStage({
      workspaceId: 'workspace-1',
      expectedHead: 'a'.repeat(40),
      entries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'unstaged' }]
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'stage',
      payload: {
        workspaceId: 'workspace-1',
        expectedHead: 'a'.repeat(40),
        entries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'unstaged' }]
      }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        operation: 'stage',
        relativePaths: ['src/app.ts'],
        mutated: true
      })
    )
    await expect(stage).resolves.toMatchObject({ operation: 'stage', mutated: true })

    const discard = harness.client.sourceControlDiscard({
      workspaceId: 'workspace-1',
      expectedHead: null,
      confirmation: 'discard-confirmed',
      entries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'unstaged' }]
    })
    harness.client.receive(
      response('B'.repeat(22), {
        workspaceId: 'workspace-1',
        operation: 'discard',
        relativePaths: ['other.ts'],
        mutated: true
      })
    )
    await expect(discard).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('rejects reordered, cross-workspace, and wrong-operation mutation results', async () => {
    for (const payload of [
      {
        workspaceId: 'workspace-1',
        operation: 'stage',
        relativePaths: ['src/b.ts', 'src/a.ts'],
        mutated: true
      },
      {
        workspaceId: 'workspace-2',
        operation: 'stage',
        relativePaths: ['src/a.ts', 'src/b.ts'],
        mutated: true
      },
      {
        workspaceId: 'workspace-1',
        operation: 'unstage',
        relativePaths: ['src/a.ts', 'src/b.ts'],
        mutated: true
      }
    ]) {
      const harness = createHarness()
      const stage = harness.client.sourceControlStage({
        workspaceId: 'workspace-1',
        expectedHead: 'a'.repeat(40),
        entries: [
          { relativePath: 'src/a.ts', status: 'modified', area: 'unstaged' },
          { relativePath: 'src/b.ts', status: 'modified', area: 'unstaged' }
        ]
      })
      harness.client.receive(response('A'.repeat(22), payload))
      await expect(stage).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
    }
  })

  it('sends commit and generation snapshots and rejects mismatched result identity', async () => {
    const harness = createHarness()
    const snapshot = {
      workspaceId: 'workspace-1',
      expectedHead: 'a'.repeat(40),
      stagedEntries: [
        { relativePath: 'src/app.ts', status: 'modified' as const, area: 'staged' as const }
      ]
    }
    const generation = harness.client.sourceControlGenerateCommitMessage(snapshot)
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'generateCommitMessage',
      payload: snapshot
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        previousHead: 'b'.repeat(40),
        status: 'generated',
        message: 'feat: wrong identity'
      })
    )
    await expect(generation).rejects.toMatchObject({ code: 'invalid_message' })

    const commit = harness.client.sourceControlCommit({ ...snapshot, message: 'feat: commit' })
    harness.client.receive(
      response('B'.repeat(22), {
        workspaceId: 'workspace-1',
        previousHead: snapshot.expectedHead,
        status: 'committed',
        head: 'c'.repeat(40)
      })
    )
    await expect(commit).resolves.toMatchObject({ status: 'committed', head: 'c'.repeat(40) })
  })

  it('sends an explicit workspace-scoped generation cancellation', async () => {
    const harness = createHarness()
    const cancellation = harness.client.sourceControlCancelCommitMessageGeneration({
      workspaceId: 'workspace-1'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'cancelCommitMessageGeneration',
      payload: { workspaceId: 'workspace-1' }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        cancellationRequested: true
      })
    )
    await expect(cancellation).resolves.toEqual({
      workspaceId: 'workspace-1',
      cancellationRequested: true
    })
  })

  it('subscribes to typed workspace-scoped status invalidations and cleans up', async () => {
    const harness = createHarness()
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = harness.client.sourceControlSubscribe(
      { workspaceId: 'workspace-1' },
      onEvent,
      onError
    )

    expect(harness.messages[0]).toMatchObject({
      mode: 'subscription',
      requestId: 'A'.repeat(22),
      subscriptionId: 'B'.repeat(22),
      capability: 'sourceControl',
      operation: 'subscribe',
      payload: { workspaceId: 'workspace-1' }
    })
    harness.client.receive(response('A'.repeat(22), null))
    await expect(subscription.ready).resolves.toBeUndefined()
    harness.client.receive({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      shellSessionId: CONTEXT.shellSessionId,
      buildId: CONTEXT.buildId,
      subscriptionId: 'B'.repeat(22),
      sequence: 0,
      payload: { workspaceId: 'workspace-1', reason: 'changed' }
    })

    expect(onEvent).toHaveBeenCalledWith({ workspaceId: 'workspace-1', reason: 'changed' })
    expect(onError).not.toHaveBeenCalled()
    subscription.unsubscribe()
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'subscription',
      id: 'B'.repeat(22)
    })
  })
})

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const requestIds = ['A'.repeat(22), 'B'.repeat(22)]
  const grantLimits = {
    maxRequestBytes: 4096,
    maxResponseBytes: 192 * 1024,
    maxConcurrent: 2,
    rateCapacity: 8,
    rateRefillPerSecond: 2
  }
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      { capability: 'sourceControl', operation: 'status', limits: grantLimits },
      { capability: 'sourceControl', operation: 'diff', limits: grantLimits },
      { capability: 'sourceControl', operation: 'branches', limits: grantLimits },
      { capability: 'sourceControl', operation: 'history', limits: grantLimits },
      { capability: 'sourceControl', operation: 'branchCompare', limits: grantLimits },
      { capability: 'sourceControl', operation: 'commitCompare', limits: grantLimits },
      { capability: 'sourceControl', operation: 'stage', limits: grantLimits },
      { capability: 'sourceControl', operation: 'unstage', limits: grantLimits },
      { capability: 'sourceControl', operation: 'discard', limits: grantLimits },
      { capability: 'sourceControl', operation: 'commit', limits: grantLimits },
      { capability: 'sourceControl', operation: 'generateCommitMessage', limits: grantLimits },
      {
        capability: 'sourceControl',
        operation: 'cancelCommitMessageGeneration',
        limits: grantLimits
      },
      { capability: 'sourceControl', operation: 'subscribe', limits: grantLimits }
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => requestIds.shift() ?? 'Z'.repeat(22)
  })
  return { client, messages }
}

function response(requestId: string, payload: unknown): MobileWebBridgeShellMessage {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId,
    status: 'success',
    payload
  }
}
