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
const HEAD = 'b'.repeat(40)
const upstream = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 1,
  behind: 0,
  hasConfiguredPushTarget: false,
  behindCommitsArePatchEquivalent: false
}

describe('mobile web source-control sync request client', () => {
  it('sends and validates typed upstream and checkout requests', async () => {
    const harness = createHarness()
    const upstreamRequest = harness.client.sourceControlUpstream({
      workspaceId: 'workspace-1'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'sourceControl',
      operation: 'upstream',
      payload: { workspaceId: 'workspace-1' }
    })
    harness.client.receive(response('A'.repeat(22), repositoryState()))
    await expect(upstreamRequest).resolves.toMatchObject({ head: HEAD, branch: 'main', upstream })

    const checkoutPayload = {
      workspaceId: 'workspace-1',
      expectedHead: HEAD,
      expectedBranch: 'main',
      branch: 'feature/mobile',
      confirmation: 'checkout-confirmed' as const
    }
    const checkout = harness.client.sourceControlCheckout(checkoutPayload)
    expect(harness.messages[1]).toMatchObject({
      capability: 'sourceControl',
      operation: 'branch',
      payload: checkoutPayload
    })
    harness.client.receive(
      response('B'.repeat(22), {
        workspaceId: 'workspace-1',
        operation: 'branch',
        previousHead: HEAD,
        previousBranch: 'main',
        branch: 'feature/mobile',
        repository: { ...repositoryState(), branch: 'feature/mobile' },
        completed: true
      })
    )
    await expect(checkout).resolves.toMatchObject({
      operation: 'branch',
      branch: 'feature/mobile',
      completed: true
    })
  })

  it('rejects cross-request action identity and strips undeclared host fields', async () => {
    const checkoutHarness = createHarness()
    const checkout = checkoutHarness.client.sourceControlCheckout({
      workspaceId: 'workspace-1',
      expectedHead: HEAD,
      expectedBranch: 'main',
      branch: 'feature/mobile',
      confirmation: 'checkout-confirmed'
    })
    checkoutHarness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'workspace-1',
        operation: 'branch',
        previousHead: 'c'.repeat(40),
        previousBranch: 'main',
        branch: 'feature/mobile',
        repository: null,
        completed: true
      })
    )
    await expect(checkout).rejects.toMatchObject({ code: 'invalid_message' })

    // An undeclared host field must not reach the page, but rejecting the whole result made one
    // additive field from a newer shell a permanent `invalid_message`. Stripping keeps the leak
    // fenced and the payload usable.
    const upstreamHarness = createHarness()
    const request = upstreamHarness.client.sourceControlUpstream({ workspaceId: 'workspace-1' })
    upstreamHarness.client.receive(
      response('A'.repeat(22), {
        ...repositoryState(),
        hostPath: '/private/repository'
      })
    )
    await expect(request).resolves.not.toHaveProperty('hostPath')
  })

  it('cancels a pending sync request when its workspace owner replaces it', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const request = harness.client.sourceControlFetch(
      {
        workspaceId: 'workspace-1',
        expectedHead: HEAD,
        expectedBranch: 'main'
      },
      { signal: controller.signal }
    )
    controller.abort()

    await expect(request).rejects.toMatchObject({ code: 'cancelled', retryable: false })
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'request',
      id: 'A'.repeat(22)
    })
  })
})

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const requestIds = ['A'.repeat(22), 'B'.repeat(22), 'C'.repeat(22)]
  const limits = {
    maxRequestBytes: 8192,
    maxResponseBytes: 8192,
    maxConcurrent: 2,
    rateCapacity: 8,
    rateRefillPerSecond: 2
  }
  const operations = ['upstream', 'branch', 'fetch', 'pull', 'push', 'rebase', 'abort'] as const
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: operations.map((operation) => ({
      capability: 'sourceControl' as const,
      operation,
      limits
    })),
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => requestIds.shift() ?? 'Z'.repeat(22)
  })
  return { client, messages }
}

function repositoryState() {
  return {
    workspaceId: 'workspace-1',
    head: HEAD,
    branch: 'main',
    conflictOperation: 'unknown',
    baseRef: 'origin/main',
    upstream
  }
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
