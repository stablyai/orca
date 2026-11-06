import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import '../items/codex-structured-item-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { MAX_CODEX_GENERIC_ROWS_PER_TURN } from './codex-structured-journal-limits'
import '../prompts/codex-structured-prompt-replies'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

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

const TURN_STARTED = notification('turn/started', { turn: { id: TURN_ID } })

function translatorWith(tap = recorder(), window = manualWindow()) {
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    bindPromptItemId: tap.bindPromptItemId,
    schedule: window.schedule
  })
  return { translator, tap, window }
}

describe('codex journal translation', () => {
  it('retains active state when eviction settlement is backpressured', () => {
    const { translator, tap } = translatorWith()
    let rejectTerminal = true
    const appendItem = tap.sink.appendItem
    tap.sink.tryAppendItem = (identity, body, options) => {
      if (rejectTerminal && body.kind === 'tool-call' && body.state === 'failed') {
        return { accepted: false as const, reason: 'backpressure' as const }
      }
      appendItem(identity, body, options)
      return { accepted: true as const }
    }
    for (let index = 0; index <= 256; index += 1) {
      const result = translator.handle(
        notification('item/started', {
          item: {
            type: 'commandExecution',
            id: `evict-${index}`,
            command: 'run',
            status: 'inProgress'
          }
        })
      )
      if (index === 256) {
        expect(result).toEqual({ accepted: false, reason: 'backpressure' })
      }
    }
    rejectTerminal = false
    expect(
      translator.handle(
        notification('item/started', {
          item: {
            type: 'commandExecution',
            id: 'evict-retry',
            command: 'run',
            status: 'inProgress'
          }
        })
      )
    ).toEqual({ accepted: true })
    expect(
      tap.rows.filter((row) => row.body.kind === 'tool-call' && row.body.state === 'failed').length
    ).toBeGreaterThan(0)
  })

  it('admits suppressed diagnostics before settling a completed turn', () => {
    const tap = recorder()
    let rejectSuppression = true
    const appendItem = tap.sink.appendItem
    tap.sink.tryAppendItem = (...args) => {
      const body = args[1]
      if (body.kind === 'status' && body.text.includes('more provider notification')) {
        return rejectSuppression
          ? { accepted: false as const, reason: 'backpressure' as const }
          : (appendItem(...args), { accepted: true as const })
      }
      appendItem(...args)
      return { accepted: true as const }
    }
    const { translator } = translatorWith(tap)
    translator.handle(TURN_STARTED)
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN + 1; index += 1) {
      translator.handle(
        notification('future/notification', { message: 'Provider note', value: index })
      )
    }
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-order', command: 'run', status: 'inProgress' }
      })
    )
    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(tap.tombstones).toEqual([])
    rejectSuppression = false
    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: true
    })
  })

  it('does not advance generic or suppression state when the sink rejects', () => {
    const { tap, window } = translatorWith()
    let reject = true
    const appendItem = tap.sink.appendItem
    tap.sink.tryAppendItem = (...args) => {
      if (reject) {
        return { accepted: false as const, reason: 'backpressure' as const }
      }
      appendItem(...args)
      return { accepted: true as const }
    }
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID,
      schedule: window.schedule
    })
    translator.handle(TURN_STARTED)
    translator.handle(notification('future/notification', { message: 'Provider note', value: 1 }))
    reject = false
    translator.handle(notification('future/notification', { message: 'Provider note', value: 2 }))
    expect(
      tap.rows.filter((row) => row.body.kind === 'status' && row.body.providerFrame)
    ).toHaveLength(1)

    for (let index = 1; index < MAX_CODEX_GENERIC_ROWS_PER_TURN; index += 1) {
      translator.handle(
        notification('future/notification', { message: 'Provider note', value: index + 2 })
      )
    }
    reject = true
    translator.handle(
      notification('future/notification', { message: 'Provider note', value: 'suppressed' })
    )
    window.fire()
    expect(tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))).toHaveLength(0)
    reject = false
    window.fire()
    expect(tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))).toHaveLength(1)
  })

  it('writes nothing more after dispose', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'gone' }))
    translator.dispose()
    window.fire()

    expect(tap.rows).toEqual([])
  })
})

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
