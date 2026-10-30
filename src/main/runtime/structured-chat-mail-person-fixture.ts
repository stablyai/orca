import { expect } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  attachParams,
  operationId,
  type FakeConnection
} from './structured-chat-coordinator-fake-codex-fixture'

export function createChatPersonActions(deps: {
  host: () => StructuredAgentSessionHost
  connectionFor: (sessionId: string) => FakeConnection
  startTurn: (sessionId: string, turnIndex: number, text?: string) => Promise<void>
  attachParams?: (sessionId: string) => Parameters<StructuredAgentSessionHost['attach']>[1]
}) {
  const paramsFor = (id: string) => deps.attachParams?.(id) ?? attachParams(id)
  async function attachChat(sessionId: string) {
    const host = deps.host()
    if (!host.deps.store.getRecord(sessionId)) {
      const fresh = paramsFor(sessionId)
      fresh.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields: { worktree: `id:${fresh.location.workspaceId}`, agent: fresh.agent }
      })
      expect(await host.create({ callerKey: 'test-surface' }, fresh)).toMatchObject({ ok: true })
    }
    const params = paramsFor(sessionId)
    params.envelope.expectedRuntimeFence = host.deps.store.getRecord(sessionId)!.lease.runtimeFence
    params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId,
      fields: attachFingerprintFields(params)
    })
    return host.attach({ callerKey: 'test-surface' }, params)
  }

  function envelope(sessionId: string, method: string, fields: Record<string, unknown>) {
    return {
      sessionId,
      clientOperationId: operationId(),
      expectedRuntimeFence: deps.host().deps.store.getRecord(sessionId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
    }
  }

  async function finishTurn(
    sessionId: string,
    turnIndex: number,
    status?: 'completed' | 'failed',
    reply = false
  ) {
    const connection = deps.connectionFor(sessionId)
    const turnId = connection.turns[turnIndex]!.turnId ?? `turn-${turnIndex + 1}`
    if (reply) {
      connection.handlers.onNotification?.('item/completed', {
        turnId,
        item: { type: 'agentMessage', id: `reply-${turnIndex}`, text: `Finished ${turnIndex}` }
      })
      connection.handlers.onNotification?.('thread/status/changed', { status: { type: 'idle' } })
    }
    connection.handlers.onNotification?.('turn/completed', {
      turn: {
        id: turnId,
        ...(status ? { status } : {}),
        ...(status === 'failed' ? { error: { message: 'connection dropped' } } : {})
      }
    })
    await deps.host().flushStreamedEvents(sessionId)
  }

  async function settleTurn(sessionId: string, turnIndex: number, status?: 'completed' | 'failed') {
    await deps.startTurn(sessionId, turnIndex)
    await finishTurn(sessionId, turnIndex, status)
  }

  return { attachChat, envelope, finishTurn, settleTurn }
}
