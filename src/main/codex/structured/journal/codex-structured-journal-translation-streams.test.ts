import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import '../items/codex-structured-item-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

import '../prompts/codex-structured-prompt-replies'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const bound: [string, string, string][] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {
      publishes += 1
    }
  }
  return {
    sink,
    rows,
    tombstones,
    bound,
    publishes: () => publishes,
    bindPromptItemId: (journalItemId: string, threadId: string, promptKey: string) =>
      bound.push([journalItemId, threadId, promptKey])
  }
}

afterEach(() => vi.useRealTimers())

function manualWindow() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  return {
    schedule: (run: () => void, ms: number) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    fire: () => vi.advanceTimersToNextTimer(),
    idle: () => vi.getTimerCount() === 0
  }
}

function notification(
  method: string,
  params: unknown
): Extract<CodexStructuredSessionEvent, { type: 'notification' }> {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function translatorWith(tap = recorder(), window = manualWindow()) {
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    bindPromptItemId: tap.bindPromptItemId,
    schedule: window.schedule
  })
  return { translator, tap, window }
}

describe('Codex streamed checkpoint admission', () => {
  it('retries a refused checkpoint before forcing a smaller final increment', () => {
    const { translator, tap, window } = translatorWith()
    let reject = false
    tap.sink.tryAppendItem = (identity, body, options) => {
      if (reject) {
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.appendItem(identity, body, options)
      return { accepted: true }
    }
    const delta = (text: string) =>
      translator.handle(notification('item/agentMessage/delta', { itemId: 'reply', delta: text }))
    delta('a'.repeat(128))
    window.fire()
    const rows = tap.rows.length
    reject = true
    delta('b'.repeat(32))
    window.fire()
    window.fire()
    expect(tap.rows).toHaveLength(rows)
    expect(window.idle()).toBe(false)

    reject = false
    window.fire()
    expect(window.idle()).toBe(true)
    expect(tap.rows.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: `${'a'.repeat(128)}${'b'.repeat(32)}` }]
    })
    delta('x')
    window.fire()
    expect(tap.rows.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: `${'a'.repeat(128)}${'b'.repeat(32)}x` }]
    })
    translator.flush()
    expect(tap.rows.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: `${'a'.repeat(128)}${'b'.repeat(32)}x` }]
    })
    translator.dispose()
  })
})

it.each(['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/plan/delta'])(
  'delivers a paused %s tail without a different thread forcing it early',
  (method) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const tap = recorder()
    const translator = createCodexJournalTranslator({ sink: tap.sink })
    const prefix = 'a'.repeat(20000)
    const delta = (text: string) =>
      translator.handle(notification(method, { itemId: 'reply', delta: text }))
    delta(prefix)
    vi.advanceTimersByTime(60)
    delta(' paused tail')
    translator.handle({
      ...notification('item/started', { item: { type: 'agentMessage', id: 'other' } }),
      threadId: 'other-thread'
    })
    vi.advanceTimersByTime(399)
    const expectedBody = (text: string) =>
      method === 'item/plan/delta'
        ? { kind: 'status', text, presentation: 'plan-document' }
        : { kind: 'message', blocks: [{ type: 'text', text }] }
    expect(tap.rows.at(-1)?.body).toMatchObject(expectedBody(prefix))
    vi.advanceTimersByTime(1)
    expect(tap.rows.at(-1)?.body).toMatchObject(expectedBody(`${prefix} paused tail`))
    delta(' final tail')
    translator.flush()
    expect(tap.rows.at(-1)?.body).toMatchObject(expectedBody(`${prefix} paused tail final tail`))
    translator.dispose()
  }
)
