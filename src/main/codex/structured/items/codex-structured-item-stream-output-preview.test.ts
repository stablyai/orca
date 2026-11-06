import { expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexStructuredItemStreams } from './codex-structured-item-streams'

function outputStream(type: 'commandExecution' | 'fileChange') {
  const bodies: AgentJournalItemBody[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => {
      bodies.push(body)
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  let timer: (() => void) | null = null
  const streams = createCodexStructuredItemStreams({
    sink,
    turnIdFor: () => 'turn',
    identityFor: (threadId, turnId) => ({
      provider: 'codex',
      threadId,
      turnId: turnId ?? 'turn',
      ordinal: 1
    }),
    attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
    schedule: (run) => {
      timer = run
      return () => {
        timer = null
      }
    }
  })
  const item = { type, id: 'cmd', status: 'inProgress', command: 'make' }
  streams.track('thread', 'turn', item, {
    provider: 'codex',
    threadId: 'thread',
    turnId: 'turn',
    ordinal: 1
  })
  return {
    bodies,
    item,
    output: (delta: string) => {
      streams.handle('thread', `item/${type}/outputDelta`, { itemId: 'cmd', delta })
      const run = timer
      timer = null
      run?.()
    },
    streams
  }
}

it.each(['commandExecution', 'fileChange'] as const)(
  'saves a running %s row whose output keeps the head, the whole length and its digest',
  (type) => {
    const { bodies, output, streams } = outputStream(type)
    // The emoji's surrogate pair is split across deltas, as a provider chunk boundary might.
    output('x'.repeat(16_384))
    output('\ud83d')
    output('\ude00tail')
    streams.flush()

    expect(bodies.at(-1)).toMatchObject({
      kind: 'tool-call',
      state: 'running',
      output: {
        head: 'x'.repeat(16_384),
        byteLength: 16_392,
        digest: 'b15858eaa966a575ef2a5e8ea52baa9756e4df7ccb5fb74106661ccaf9885b59',
        truncated: true
      }
    })
    // Interruption still saves the whole output.
    expect(streams.snapshot('thread', 'cmd')?.text).toBe(`${'x'.repeat(16_384)}\u{1F600}tail`)
  }
)

it('keeps short running output whole', () => {
  const { bodies, output, streams } = outputStream('commandExecution')
  output('ok \ud83d')
  output('\ude00\n')
  streams.flush()

  expect(bodies.at(-1)).toMatchObject({
    output: {
      head: 'ok \u{1F600}\n',
      byteLength: 8,
      digest: '2b39e39924d0fdb9c893da964e00b2a9fddea62fa60b00abf448574a92bdfdcb',
      truncated: false
    }
  })
})
