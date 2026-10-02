// Claude frames that reach the host only as a noted frame: a text delta between the journal's
// checkpoints, and a thinking delta, which no row write, publish or activity update carries.

import { describe, expect, it } from 'vitest'
import { recordingEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink-call-recorder'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

async function acquiredWithRecordingSink() {
  const claude = fakeClaude()
  const recorder = recordingEventSink()
  const adapter = adapterFor(claude)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recorder.sink
  })
  const frame = (delta: Record<string, unknown>, uuid: string) =>
    claude.connections[0]!.handlers.onMessage?.({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta },
      session_id: PROVIDER_SESSION_ID,
      uuid
    })
  return { ...recorder, frame }
}

describe('Claude frames as chat activity', () => {
  it('reaches the sink only as a noted frame for a text delta between checkpoints', async () => {
    const { calls, frame } = await acquiredWithRecordingSink()
    // The block's first text is its first checkpoint; later deltas wait for it to grow.
    frame({ type: 'text_delta', text: 'x' }, 'stream-1')
    await settle()
    const before = calls.length

    frame({ type: 'text_delta', text: 'x' }, 'stream-2')
    await settle()

    expect(calls.slice(before)).toEqual(['noteProviderFrame'])
  })

  it('reaches the sink only as a noted frame for a thinking delta', async () => {
    const { calls, frame } = await acquiredWithRecordingSink()
    const before = calls.length

    frame({ type: 'thinking_delta', thinking: 'weighing the options' }, 'thinking-1')
    await settle()

    expect(calls.slice(before)).toEqual(['noteProviderFrame'])
  })
})
