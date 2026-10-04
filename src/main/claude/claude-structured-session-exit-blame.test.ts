// After a Claude start lands, only the child's own exit says Claude stopped; a fault on Orca's
// side that makes Orca close the child is Orca's.

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

async function startedClaude(sink: StructuredAgentSessionEventSink) {
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterFor(claude, {}, events)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9', events: sink })
  const ended = async () => {
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ended')).toBe(true))
    return events.find((event) => event.type === 'ended')
  }
  return { connection: claude.connections[0], ended }
}

describe('what a started Claude session says ended it', () => {
  it('says Claude stopped when the child exits on its own', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    })

    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): killed'))

    expect(await ended()).toMatchObject({
      cause: 'unexpected-exit',
      failure: { kind: 'providerExited' }
    })
  })

  it('blames Orca when a journal fault makes Orca close the child', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      tryAppendResolvedItemAndPublish: () => ({ accepted: false, reason: 'failed' })
    })

    connection.handlers.onMessage?.({
      type: 'system',
      subtype: 'task_notification',
      session_id: PROVIDER_SESSION_ID,
      task_id: 'task-1',
      status: 'failed',
      summary: 'failed'
    })

    expect(await ended()).toMatchObject({
      reason: 'claude background task journal sink failed',
      cause: 'unexpected-exit',
      failure: { kind: 'hostFault' }
    })
    expect(connection.closeCount).toBeGreaterThanOrEqual(1)
  })
})
