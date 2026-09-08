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
const REQUEST_ID = 'R'.repeat(22)
const TARGET = {
  workspaceId: 'workspace-page',
  tabId: 'tab-1',
  relativePath: 'notes.md'
}
const HOST_TARGET = { tabId: TARGET.tabId, relativePath: TARGET.relativePath }

describe('mobile web markdown request client', () => {
  it.each(['markdownRead', 'markdownSave', 'markdownDraftRead'] as const)(
    'preserves a leading BOM in %s responses',
    async (operation) => {
      const harness = createHarness(operation)
      const content = '﻿# Notes\r\nλ'
      const contentBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)))
      const pending =
        operation === 'markdownRead'
          ? harness.client.markdown.read({ ...TARGET, tabIsDirty: false })
          : operation === 'markdownSave'
            ? harness.client.markdown.save({ ...TARGET, content, baseVersion: 'v1' })
            : harness.client.markdown.loadDraft(TARGET)
      harness.client.receive(
        response(
          operation === 'markdownDraftRead'
            ? { ...TARGET, draft: { contentBase64, baseVersion: 'v1' } }
            : operation === 'markdownSave'
              ? { outcome: 'saved', ...HOST_TARGET, contentBase64, baseVersion: 'v1' }
              : { ...HOST_TARGET, contentBase64, baseVersion: 'v1', editable: true, stale: false }
        )
      )
      await expect(pending).resolves.toMatchObject({ content, baseVersion: 'v1' })
    }
  )

  it('saves through the generic host lane and decodes an exact-identity result', async () => {
    const harness = createHarness('markdownSave')
    const saving = harness.client.markdown.save({
      ...TARGET,
      content: 'phone edit',
      baseVersion: 'v1'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.markdown.save',
        workspaceId: TARGET.workspaceId,
        params: { ...HOST_TARGET, contentBase64: btoa('phone edit'), baseVersion: 'v1' }
      }
    })
    harness.client.receive(
      response({
        outcome: 'saved',
        ...HOST_TARGET,
        contentBase64: btoa('saved'),
        baseVersion: 'v2'
      })
    )
    await expect(saving).resolves.toEqual({ ...TARGET, content: 'saved', baseVersion: 'v2' })
  })

  it('surfaces a stale base version as a conflict the editor can act on', async () => {
    const harness = createHarness('markdownSave')
    const saving = harness.client.markdown.save({ ...TARGET, content: 'edit', baseVersion: 'v1' })
    harness.client.receive(response({ outcome: 'conflict' }))
    await expect(saving).rejects.toMatchObject({ code: 'conflict', retryable: false })
  })

  it('reads a tab whose host path the page cannot express', async () => {
    const harness = createHarness('markdownRead')
    const target = { workspaceId: TARGET.workspaceId, tabId: TARGET.tabId }
    const reading = harness.client.markdown.read({ ...target, tabIsDirty: true })
    expect(harness.messages[0]).toMatchObject({
      payload: { method: 'mobileWeb.markdown.read', params: { tabId: 'tab-1', tabIsDirty: true } }
    })
    harness.client.receive(
      response({
        tabId: 'tab-1',
        contentBase64: btoa('outside'),
        baseVersion: '',
        editable: false,
        stale: true,
        readOnlyReason: 'Editing needs Orca desktop running.'
      })
    )
    await expect(reading).resolves.toMatchObject({ content: 'outside', editable: false })
  })

  it('rejects a response bound to another path', async () => {
    const harness = createHarness('markdownRead')
    const reading = harness.client.markdown.read({ ...TARGET, tabIsDirty: false })
    harness.client.receive(
      response({
        ...HOST_TARGET,
        relativePath: 'other.md',
        contentBase64: btoa('secret'),
        baseVersion: 'v1',
        editable: true,
        stale: false
      })
    )

    await expect(reading).rejects.toMatchObject({
      code: 'invalid_message',
      retryable: false
    })
  })
})

function createHarness(operation: 'markdownRead' | 'markdownSave' | 'markdownDraftRead') {
  const messages: MobileWebBridgePageMessage[] = []
  const limits = {
    maxRequestBytes: 512 * 1024,
    maxResponseBytes: 512 * 1024,
    maxConcurrent: 1,
    rateCapacity: 4,
    rateRefillPerSecond: 1
  }
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants:
      operation === 'markdownDraftRead'
        ? [{ capability: 'file', operation, limits }]
        : [{ capability: 'workspace', operation: 'hostRequest', limits }],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => REQUEST_ID
  })
  return { client, messages }
}

function response(payload: unknown): MobileWebBridgeShellMessage {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    status: 'success',
    payload
  }
}
