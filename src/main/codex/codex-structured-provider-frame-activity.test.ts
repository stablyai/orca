// A Codex frame that reaches the host only as a noted frame: a streamed delta between the
// journal's checkpoints, which no row write, publish or activity update carries.

import { describe, expect, it } from 'vitest'
import { recordingEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink-call-recorder'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('Codex frames as chat activity', () => {
  it('reaches the sink only as a noted frame for an agent text delta between checkpoints', async () => {
    const codex = fakeCodex()
    const { sink, calls } = recordingEventSink()
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const delta = (text: string) =>
      codex.connections[0]!.handlers.onNotification?.('item/agentMessage/delta', {
        threadId: THREAD_ID,
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: text
      })
    // The item's first text is its first checkpoint; later deltas wait for it to grow.
    delta('streamed')
    await settle()
    const before = calls.length

    delta('x')
    await settle()

    expect(calls.slice(before)).toEqual(['noteProviderFrame'])
  })

  it('notes an approval request at receipt, before anything it writes', async () => {
    const codex = fakeCodex()
    const { sink, calls } = recordingEventSink()
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const before = calls.length

    codex.connections[0]!.handlers.onServerRequest?.({
      id: 5,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'codex-item-1', threadId: THREAD_ID, turnId: 'turn-1' }
    })
    await settle()

    expect(calls.slice(before)[0]).toBe('noteProviderFrame')
  })
})
