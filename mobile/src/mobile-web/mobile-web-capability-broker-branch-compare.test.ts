import { describe, expect, it, vi } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'

const WORKSPACE_ID = `workspace_0_${'01'.repeat(16)}`

describe('mobile web branch-compare rate accounting', () => {
  it('exempts only the exact next page after a charged snapshot request', async () => {
    const harness = createHarness()
    await harness.broker.handle(workspaceSnapshotRequest())

    for (let index = 0; index < 8; index += 1) {
      await harness.broker.handle(branchCompareRequest(String(index).repeat(22), firstPayload()))
    }
    const firstPage = successPayload(harness.messages.at(-1))
    const continuation = continuationPayload(firstPage)

    await harness.broker.handle(branchCompareRequest('C'.repeat(22), continuation))
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'success',
      payload: { offset: 128, nextOffset: null }
    })
    expect(gitCompareCalls(harness.sendRequest)).toHaveLength(8)

    await harness.broker.handle(branchCompareRequest('R'.repeat(22), continuation))
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'rate_limited', retryable: true }
    })
    expect(gitCompareCalls(harness.sendRequest)).toHaveLength(8)
  })
})

function createHarness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
    if (method === 'worktree.ps') {
      return {
        ok: true,
        result: { worktrees: [{ worktreeId: 'workspace-1', repoId: 'repo-1' }] }
      }
    }
    if (method === 'git.branchCompare') {
      return { ok: true, result: compareResult() }
    }
    return { ok: false, error: { code: 'method_not_found', message: 'unsupported' } }
  })
  const client = { sendRequest, subscribe: vi.fn() } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    now: () => 1_000
  })
  return { broker, messages, sendRequest }
}

function workspaceSnapshotRequest(): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return request('P'.repeat(22), 'workspace', 'snapshot', { limit: 1 })
}

function branchCompareRequest(
  requestId: string,
  payload: Record<string, unknown>
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return request(requestId, 'sourceControl', 'branchCompare', payload)
}

function request(
  requestId: string,
  capability: string,
  operation: string,
  payload: unknown
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({ requestId, capability, operation, payload })
}

function firstPayload() {
  return { workspaceId: WORKSPACE_ID, baseRef: 'main', offset: 0, limit: 128 }
}

function continuationPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.revision !== 'string' || value.nextOffset !== 128) {
    throw new Error('Expected a branch-compare continuation')
  }
  return { ...firstPayload(), offset: value.nextOffset, expectedRevision: value.revision }
}

function compareResult() {
  return {
    summary: {
      baseOid: 'a'.repeat(40),
      compareRef: 'feature/mobile',
      headOid: 'b'.repeat(40),
      mergeBase: 'a'.repeat(40),
      changedFiles: 129,
      status: 'ready'
    },
    entries: Array.from({ length: 129 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'modified'
    }))
  }
}

function successPayload(message: MobileWebBridgeShellMessage | undefined): unknown {
  if (message?.type !== 'response' || message.status !== 'success') {
    throw new Error(`Expected a successful response: ${JSON.stringify(message)}`)
  }
  return message.payload
}

function gitCompareCalls(sendRequest: ReturnType<typeof vi.fn<RpcClient['sendRequest']>>) {
  return sendRequest.mock.calls.filter(([method]) => method === 'git.branchCompare')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
