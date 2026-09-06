/**
 * The shell (APK) authors every result and event; the page is served by the desktop and can be an
 * older release. Before this, one field a newer APK added failed the page's `.strict()` parse as
 * `invalid_message` with `retryable: false`, which killed the session subscription *and* its
 * one-shot fallback on the same byte — "Loading tabs" forever, surviving force-quit.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const REQUEST_ID = 'Q'.repeat(22)
const SUBSCRIPTION_ID = 'S'.repeat(22)

const KNOWN_TAB = {
  id: 'tab-1',
  title: 'Terminal',
  isActive: true,
  type: 'terminal',
  status: 'ready'
}

/** A snapshot from a shell release the page predates. */
function futureSnapshot(): Record<string, unknown> {
  return {
    workspaceId: 'workspace-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 4,
    activeTabId: 'tab-2',
    activeTabType: 'canvas',
    sessionRevision: 12,
    tabs: [
      { ...KNOWN_TAB, pinnedAt: 1730000000 },
      { id: 'tab-2', title: 'Canvas', isActive: false, type: 'canvas', documentId: 'doc-1' }
    ],
    truncated: false
  }
}

function envelope() {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION as typeof MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId
  }
}

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const ids = [REQUEST_ID, SUBSCRIPTION_ID]
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: (['subscribe', 'snapshot'] as const).map((operation) => ({
      capability: 'session' as const,
      operation,
      limits: {
        maxRequestBytes: 1024,
        maxResponseBytes: 128 * 1024,
        maxConcurrent: 2,
        rateCapacity: 4,
        rateRefillPerSecond: 1
      }
    })),
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
  })
  return { client, messages }
}

function subscriptionAck(): MobileWebBridgeShellMessage {
  return {
    ...envelope(),
    type: 'response',
    requestId: REQUEST_ID,
    status: 'success',
    payload: null
  }
}

describe('forward-compatible shell payloads', () => {
  it('delivers a newer shell snapshot over the subscription with the unknown tab dropped', async () => {
    const { client } = createHarness()
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, onEvent, onError)
    client.receive(subscriptionAck())
    await subscription.ready

    client.receive({
      ...envelope(),
      type: 'event',
      subscriptionId: SUBSCRIPTION_ID,
      sequence: 0,
      payload: futureSnapshot()
    })

    expect(onError).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 4,
      activeTabId: 'tab-2',
      activeTabType: null,
      tabs: [KNOWN_TAB],
      truncated: false
    })
  })

  it('resolves the one-shot snapshot fallback from the same newer shell', async () => {
    const { client } = createHarness()
    const pending = client.sessionSnapshot({ workspaceId: 'workspace-1' })

    client.receive({
      ...envelope(),
      type: 'response',
      requestId: REQUEST_ID,
      status: 'success',
      payload: futureSnapshot()
    })

    await expect(pending).resolves.toMatchObject({ activeTabType: null, tabs: [KNOWN_TAB] })
  })

  it('still fails a snapshot whose known fields are wrong', async () => {
    const { client } = createHarness()
    const pending = client.sessionSnapshot({ workspaceId: 'workspace-1' })

    client.receive({
      ...envelope(),
      type: 'response',
      requestId: REQUEST_ID,
      status: 'success',
      payload: { ...futureSnapshot(), truncated: 'no' }
    })

    await expect(pending).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })
})
