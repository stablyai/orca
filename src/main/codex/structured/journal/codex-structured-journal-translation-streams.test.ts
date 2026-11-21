import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
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

function manualWindow() {
  const pending: (() => void)[] = []
  return {
    schedule: (run: () => void) => {
      pending.push(run)
      return () => {
        const index = pending.indexOf(run)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const run of due) {
        run()
      }
    },
    idle: () => pending.length === 0
  }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
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
    expect(tap.rows).toHaveLength(rows + 1)
    translator.flush()
    expect(tap.rows.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: `${'a'.repeat(128)}${'b'.repeat(32)}x` }]
    })
    translator.dispose()
  })
})

it('shows a paused Codex reply tail without saving it', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const tap = recorder()
    let read: (epoch: string) => readonly AgentJournalRenderItem[] = () => []
    const shown: string[] = []
    tap.sink.tryAppendItem = (identity, body, _options, onCommitted) => {
      tap.rows.push({ key: agentJournalItemKey(identity), body })
      onCommitted?.(
        {
          itemId: agentJournalItemKey(identity),
          revision: tap.rows.length,
          sequence: 3,
          observedAt: 1,
          body
        },
        'epoch'
      )
      return { accepted: true }
    }
    tap.sink.bindLiveText = (source) => {
      read = source.read
      return () => {}
    }
    tap.sink.publishLiveText = () => {
      for (const item of read('epoch')) {
        if (item.body.kind === 'message' && item.body.blocks[0]?.type === 'text') {
          shown.push(item.body.blocks[0].text)
        }
      }
      return { accepted: true }
    }
    const translator = createCodexJournalTranslator({ sink: tap.sink })
    const delta = (text: string) =>
      translator.handle(notification('item/agentMessage/delta', { itemId: 'reply', delta: text }))
    const prefix = 'a'.repeat(20000)
    delta(prefix)
    vi.advanceTimersByTime(60)
    const saves = tap.rows.length
    delta(' paused tail')
    vi.advanceTimersByTime(60)
    expect(shown).toEqual([`${prefix} paused tail`])
    expect(tap.rows).toHaveLength(saves)
    vi.advanceTimersByTime(60_000)
    expect(tap.rows).toHaveLength(saves)
    translator.dispose()
  } finally {
    vi.useRealTimers()
  }
})
