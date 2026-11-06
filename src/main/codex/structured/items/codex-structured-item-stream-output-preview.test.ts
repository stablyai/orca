import { expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  boundRunningToolOutput,
  JOURNAL_RUNNING_PREVIEW_LIMITS
} from '../../../native-chat/agent-session-journal/journal-payload-bounds'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexStructuredItemStreams } from './codex-structured-item-streams'
import { codexStreamingJournalItem } from './codex-structured-item-translation'

const HEAD_BYTES = JOURNAL_RUNNING_PREVIEW_LIMITS.inlineHeadBytes

function outputStream(type: 'commandExecution' | 'fileChange') {
  const bodies: AgentJournalItemBody[] = []
  const sink = {
    appendItem: (_identity: unknown, body: AgentJournalItemBody) => {
      bodies.push(body)
    },
    appendTombstone: () => {},
    publish: () => {}
  } as unknown as StructuredAgentSessionEventSink
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

it.each([
  ['commandExecution', 64],
  ['commandExecution', 640],
  ['fileChange', 640]
] as const)(
  'saves running %s previews of %i KiB of output without re-reading it per checkpoint',
  (type, kib) => {
    const { bodies, item, output, streams } = outputStream(type)
    // The previous whole-output translation is the expected saved form.
    const body = (text: string) => codexStreamingJournalItem(item, text).body
    const line = `${'build step output '.repeat(56)}\u{1F600}\n`
    const join = Array.prototype.join
    let joined = 0
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string
    ) {
      const result = join.call(this, separator)
      if (separator === '') {
        joined += result.length
      }
      return result
    })
    let text = ''
    const expected: AgentJournalItemBody[] = []
    const send = (delta: string) => {
      output(delta)
      text += delta
      while (expected.length < bodies.length) {
        expected.push(body(text)!)
      }
    }
    // Split the emoji's surrogate pair across deltas, as a provider chunk boundary might.
    const cut = line.length - 2
    while (Buffer.byteLength(text, 'utf8') < kib * 1024) {
      send(line.slice(0, cut))
      send(line.slice(cut))
    }
    spy.mockRestore()

    expect(bodies.length).toBeGreaterThan(10)
    // Each saved row matches the preview that whole-output hashing would have stored.
    expect(bodies.map(boundRunningToolOutput)).toEqual(expected.map(boundRunningToolOutput))
    // A checkpoint materializes at most its preview head, whatever the output length.
    expect(joined).toBeLessThanOrEqual(bodies.length * HEAD_BYTES)
    // Interruption still saves the whole output.
    expect(streams.snapshot('thread', 'cmd')?.text).toBe(text)
  }
)
