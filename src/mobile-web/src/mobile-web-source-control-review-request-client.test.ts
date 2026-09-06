import { describe, expect, it } from 'vitest'
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
const revision = 'b'.repeat(64)

describe('mobile web source-control review request client', () => {
  it('sends typed metadata and rejects cross-workspace results', async () => {
    const harness = createHarness()
    const request = harness.client.sourceControlReviewMetadata({ workspaceId: 'workspace-1' })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'reviewMetadata',
      payload: { workspaceId: 'workspace-1' }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-2',
        revision,
        comments: [],
        reviewState: { version: 1, files: [] }
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('requires matching review diff identity', async () => {
    const harness = createHarness()
    const request = harness.client.sourceControlReviewDiff({
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
      scope: 'branch',
      compare: {
        baseRef: 'main',
        headOid: 'c'.repeat(40),
        mergeBase: 'd'.repeat(40)
      },
      offset: 0,
      limit: 20
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'reviewDiff',
      payload: { relativePath: 'src/app.ts', scope: 'branch' }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        relativePath: 'other.ts',
        scope: 'branch',
        kind: 'binary'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('sends explicit open and terminal operations', async () => {
    const harness = createHarness()
    const open = harness.client.sourceControlReviewOpen({
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
      scope: 'staged'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'reviewOpen'
    })
    harness.client.receive(response('A'.repeat(22), null))
    await expect(open).resolves.toBeNull()

    const send = harness.client.sourceControlReviewTerminalSend({
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      text: 'Review prompt',
      enter: true
    })
    expect(harness.messages[1]).toMatchObject({
      capability: 'sourceControl',
      operation: 'reviewTerminalSend',
      payload: { workspaceId: 'workspace-1', tabId: 'tab-1' }
    })
    harness.client.receive(response('B'.repeat(22), { accepted: true }))
    await expect(send).resolves.toEqual({ accepted: true })
  })
})

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const requestIds = ['A'.repeat(22), 'B'.repeat(22)]
  const limits = {
    maxRequestBytes: 768 * 1024,
    maxResponseBytes: 768 * 1024,
    maxConcurrent: 2,
    rateCapacity: 8,
    rateRefillPerSecond: 2
  }
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      { capability: 'sourceControl', operation: 'reviewMetadata', limits },
      { capability: 'sourceControl', operation: 'reviewMetadataUpdate', limits },
      { capability: 'sourceControl', operation: 'reviewDiff', limits },
      { capability: 'sourceControl', operation: 'reviewOpen', limits },
      { capability: 'sourceControl', operation: 'reviewTerminalSend', limits }
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
