import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const REQUEST_ID = 'R'.repeat(22)
const WORKSPACE_ID = 'workspace-page'
const REF = { agent: 'claude' as const, sessionId: 'provider-session-1' }
const TARGET = { workspaceId: WORKSPACE_ID, scope: 'workspace' as const, ...REF }

const row = {
  ...REF,
  agentLabel: 'Claude Code',
  title: 'Fix the parser',
  lastMessage: 'done',
  messageCount: 4,
  updatedAt: 1_756_000_000_000,
  groupKey: 'group_0',
  groupLabel: 'app',
  isCurrentWorkspace: true,
  resumeAvailable: true
}

describe('mobile web agent history request client', () => {
  it('asks the desktop for a scoped page and parses the rows', async () => {
    const harness = createHarness()
    const pending = harness.client.agentHistory.snapshot({
      workspaceId: WORKSPACE_ID,
      scope: 'project',
      query: 'parser',
      force: true,
      offset: 64
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.agentHistory.snapshot',
        workspaceId: WORKSPACE_ID,
        params: { scope: 'project', query: 'parser', force: true, offset: 64 }
      }
    })
    harness.client.receive(
      response({ supported: true, sessions: [row], skippedTranscriptCount: 2, nextOffset: 64 })
    )
    await expect(pending).resolves.toEqual({
      supported: true,
      sessions: [row],
      skippedTranscriptCount: 2,
      nextOffset: 64
    })
  })

  it('addresses a preview by the agent and provider id the listing reported', async () => {
    const harness = createHarness()
    const pending = harness.client.agentHistory.preview(TARGET)
    expect(harness.messages[0]).toMatchObject({
      payload: {
        method: 'mobileWeb.agentHistory.preview',
        workspaceId: WORKSPACE_ID,
        params: { scope: 'workspace', ...REF }
      }
    })
    harness.client.receive(response({ messages: [{ role: 'user', text: 'hello' }] }))
    await expect(pending).resolves.toEqual({ messages: [{ role: 'user', text: 'hello' }] })
  })

  it('refuses a session id the page contract does not bound', async () => {
    const harness = createHarness()
    await expect(
      harness.client.agentHistory.preview({ ...TARGET, sessionId: '' })
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false })
    expect(harness.messages).toHaveLength(0)
  })

  it('parses both resume outcomes and rejects an unknown one', async () => {
    for (const result of [
      {
        status: 'queued',
        targetIsCurrentWorkspace: false,
        targetWorktreeId: 'workspace-2',
        targetWorkspaceName: 'Other'
      },
      { status: 'blocked', message: 'This session is missing a resume id.' }
    ]) {
      const harness = createHarness()
      const pending = harness.client.agentHistory.resume(TARGET)
      harness.client.receive(response(result))
      await expect(pending).resolves.toEqual(result)
    }

    const harness = createHarness()
    const pending = harness.client.agentHistory.resume(TARGET)
    harness.client.receive(response({ status: 'queued', targetWorkspaceName: 'Other' }))
    await expect(pending).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('refuses a row the page schema does not bound', async () => {
    const harness = createHarness()
    const pending = harness.client.agentHistory.snapshot({
      workspaceId: WORKSPACE_ID,
      scope: 'workspace',
      query: '',
      force: false
    })
    harness.client.receive(
      response({
        supported: true,
        sessions: [{ ...row, agent: 'not-an-agent' }],
        skippedTranscriptCount: 0,
        nextOffset: null
      })
    )
    await expect(pending).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })
})

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      {
        capability: 'workspace',
        operation: 'hostRequest',
        limits: {
          maxRequestBytes: 4096,
          maxResponseBytes: 512 * 1024,
          maxConcurrent: 2,
          rateCapacity: 8,
          rateRefillPerSecond: 2
        }
      }
    ],
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
