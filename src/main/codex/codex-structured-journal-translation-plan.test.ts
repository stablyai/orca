import { expect, it, vi } from 'vitest'
import { createAgentSessionDeltaCoalescer } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'

function recorder() {
  const rows: { body: AgentJournalItemBody }[] = []
  let publications = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => {
      rows.push({ body })
    },
    appendTombstone: () => {},
    publish: () => {
      publications++
    }
  }
  return { rows, sink, publishes: () => publications }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function translatorWith() {
  const tap = recorder()
  const pending = new Set<() => void>()
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    bindPromptItemId: () => {},
    schedule: (run) => {
      pending.add(run)
      return () => pending.delete(run)
    }
  })
  return {
    tap,
    translator,
    window: {
      fire: () => {
        const due = [...pending]
        pending.clear()
        due.forEach((run) => run())
      },
      idle: () => pending.size === 0
    }
  }
}

it('delivers synthetic plan text on elapsed ordinary arrivals and preserves first timing through wall rollback', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(500000)
  const tap = recorder()
  const appended = vi.spyOn(tap.sink, 'appendItem')
  const translator = createCodexJournalTranslator({ sink: tap.sink, bindPromptItemId: () => {} })
  const delta = (text: string) =>
    translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: text }))
  try {
    translator.handle(
      notification('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
    )
    delta('')
    vi.advanceTimersByTime(60)
    expect(tap.rows).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(40)
    delta('P'.repeat(100))
    vi.advanceTimersByTime(59)
    expect(tap.rows).toEqual([])
    vi.advanceTimersByTime(1)
    expect(tap.rows.at(-1)?.body).toMatchObject({
      text: 'P'.repeat(100),
      presentation: 'plan-document'
    })
    const first = appended.mock.calls[0]
    delta('')
    vi.advanceTimersByTime(400)
    vi.setSystemTime(100)
    delta('T')
    vi.advanceTimersByTime(60)
    expect(tap.rows).toHaveLength(2)
    expect(tap.rows.at(-1)?.body).toMatchObject({ text: `${'P'.repeat(100)}T` })
    expect(appended.mock.calls[1][0]).toEqual(first[0])
    expect(appended.mock.calls[1][2]).toEqual(first[2])
    delta('U')
    vi.advanceTimersByTime(60)
    expect(tap.rows).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(1)
    translator.handle(
      notification('item/completed', {
        item: { type: 'plan', id: 'plan', text: `${'P'.repeat(100)}TU final` }
      })
    )
    expect(tap.rows.at(-1)?.body).toMatchObject({
      text: `${'P'.repeat(100)}TU final`,
      presentation: 'plan-document'
    })
    expect(appended.mock.calls.at(-1)?.[0]).toEqual(first[0])
    expect(appended.mock.calls.at(-1)?.[2]).toMatchObject(first[2])
  } finally {
    translator.dispose()
    vi.useRealTimers()
  }
})

it.each(['append', 'publication'] as const)(
  'does not spend synthetic plan eligibility on %s refusal',
  (boundary) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const tap = recorder()
    let refused = true
    tap.sink.tryAppendItem = (id, body, options) => {
      if (refused && boundary === 'append') {
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.appendItem(id, body, options)
      return { accepted: true }
    }
    tap.sink.tryPublish = () => {
      if (refused && boundary === 'publication') {
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.publish()
      return { accepted: true }
    }
    const translator = createCodexJournalTranslator({ sink: tap.sink, bindPromptItemId: () => {} })
    try {
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'P' }))
      vi.advanceTimersByTime(60)
      expect(tap.publishes()).toBe(0)
      refused = false
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'T' }))
      vi.advanceTimersByTime(60)
      expect(tap.rows.at(-1)?.body).toMatchObject({ text: 'PT', presentation: 'plan-document' })
      expect(tap.publishes()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      translator.dispose()
      vi.useRealTimers()
    }
  }
)

it.each([false, true])(
  'orders synthetic child plan first admission, ordinary skip and matching force; missing start=%s',
  (missingStart) => {
    const { translator, tap, window } = translatorWith()
    const child = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: SESSION_ID,
        threadId: 'child',
        method,
        params
      })
    const plans = () =>
      tap.rows.filter(
        (row) => row.body.kind === 'status' && row.body.presentation === 'plan-document'
      )
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      if (!missingStart) {
        child('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
      }
      child('item/plan/delta', { itemId: 'plan', delta: 'P'.repeat(100) })
      translator.handle(
        notification('item/started', {
          item: { type: 'commandExecution', id: 'root-tool', command: 'pwd' }
        })
      )
      expect(tap.rows.slice(0, 2).map((row) => row.body.kind)).toEqual(['status', 'tool-call'])
      expect(plans()).toHaveLength(1)
      clock.mockReturnValue(100)
      child('item/plan/delta', { itemId: 'plan', delta: 'T' })
      window.fire()
      for (let i = 0; i < 10; i++) {
        translator.handle(
          notification('item/started', {
            item: { type: 'commandExecution', id: `tool-${i}`, command: 'pwd' }
          })
        )
      }
      expect(plans()).toHaveLength(1)
      expect(window.idle()).toBe(false)
      child('item/started', {
        item: { type: 'commandExecution', id: 'child-tool', command: 'pwd' }
      })
      expect(plans()).toHaveLength(2)
      expect(plans().at(-1)?.body).toMatchObject({ text: `${'P'.repeat(100)}T` })
    } finally {
      clock.mockRestore()
      translator.dispose()
    }
  }
)

it.each([
  ['commandExecution', 'item/commandExecution/outputDelta'],
  ['fileChange', 'item/fileChange/outputDelta']
])('keeps %s full previews on growth checkpoints despite elapsed time', (type, method) => {
  const { translator, tap, window } = translatorWith()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    translator.handle(notification(method, { itemId: 'output', delta: 'P'.repeat(100) }))
    window.fire()
    const before = tap.rows.length
    clock.mockReturnValue(400)
    translator.handle(notification(method, { itemId: 'output', delta: 'T' }))
    window.fire()
    expect(tap.rows).toHaveLength(before)
    expect(window.idle()).toBe(true)
    translator.flush()
    expect(tap.rows).toHaveLength(before + 1)
    expect(tap.rows.at(-1)?.body).toMatchObject(
      type === 'commandExecution'
        ? { output: { head: `${'P'.repeat(100)}T` } }
        : { patch: { head: `${'P'.repeat(100)}T` } }
    )
  } finally {
    clock.mockRestore()
    translator.dispose()
  }
})

it('delivers an owed plan tail at accepted plus400 without another input', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const tap = recorder()
  const translator = createCodexJournalTranslator({ sink: tap.sink, bindPromptItemId: () => {} })
  try {
    translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'P' }))
    vi.advanceTimersByTime(60)
    expect(tap.rows.map((row) => row.body)).toMatchObject([{ text: 'P' }])
    vi.advanceTimersByTime(40)
    translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'T' }))
    vi.advanceTimersByTime(359)
    expect(tap.rows).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(tap.rows.map((row) => row.body)).toMatchObject([{ text: 'P' }, { text: 'PT' }])
    expect(tap.publishes()).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    translator.dispose()
    vi.useRealTimers()
  }
})

it('leaves the assistant ordinary500 window intact when the plan tail wakes at460', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const tap = recorder()
  const translator = createCodexJournalTranslator({ sink: tap.sink })
  const delta = (method: string, itemId: string, text: string) =>
    translator.handle(notification(method, { itemId, delta: text }))
  try {
    delta('item/plan/delta', 'plan', 'P')
    vi.advanceTimersByTime(60)
    vi.advanceTimersByTime(10)
    delta('item/agentMessage/delta', 'assistant', 'A')
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'barrier', command: 'pwd' }
      })
    )
    vi.advanceTimersByTime(30)
    delta('item/plan/delta', 'plan', 'T')
    vi.advanceTimersByTime(340)
    delta('item/agentMessage/delta', 'assistant', 'B')
    const messages = () => tap.rows.filter((row) => row.body.kind === 'message')
    vi.advanceTimersByTime(20)
    expect(tap.rows.at(-1)?.body).toMatchObject({ text: 'PT' })
    expect(messages().map((row) => row.body)).toMatchObject([{ blocks: [{ text: 'A' }] }])
    vi.advanceTimersByTime(39)
    expect(messages()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(messages().map((row) => row.body)).toMatchObject([
      { blocks: [{ text: 'A' }] },
      { blocks: [{ text: 'AB' }] }
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    translator.dispose()
    vi.useRealTimers()
  }
})

it.each(['full', 'empty', 'textless', 'turn', 'retrack'] as const)(
  'settles plan tail debt at the %s barrier without resurrecting old text',
  (boundary) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const tap = recorder()
    const translator = createCodexJournalTranslator({ sink: tap.sink })
    const delta = (text: string) =>
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: text }))
    try {
      translator.handle(notification('turn/started', { turn: { id: 'turn' } }))
      delta('P')
      vi.advanceTimersByTime(60)
      delta('T')
      vi.advanceTimersByTime(60)
      if (boundary === 'turn') {
        translator.handle(
          notification('turn/completed', { turn: { id: 'turn', status: 'completed' } })
        )
      } else if (boundary === 'retrack') {
        translator.handle(
          notification('item/started', { item: { type: 'plan', id: 'plan', text: 'replacement' } })
        )
      } else {
        translator.handle(
          notification('item/completed', {
            item: {
              type: 'plan',
              id: 'plan',
              ...(boundary === 'textless'
                ? {}
                : { text: boundary === 'empty' ? '' : 'authoritative' })
            }
          })
        )
      }
      const atBarrier = tap.rows.length
      vi.advanceTimersByTime(1000)
      expect(tap.rows).toHaveLength(atBarrier)
      expect(vi.getTimerCount()).toBe(0)
      const plans = () =>
        tap.rows.filter(
          (row) => row.body.kind === 'status' && row.body.presentation === 'plan-document'
        )
      expect(plans().some((row) => row.body.kind === 'status' && row.body.text === 'PT')).toBe(true)
      if (boundary === 'full' || boundary === 'retrack') {
        expect(plans().at(-1)?.body).toMatchObject({
          text: boundary === 'full' ? 'authoritative' : 'replacement'
        })
      }
      if (boundary === 'turn') {
        delta('U')
        vi.advanceTimersByTime(60)
        expect(plans().at(-1)?.body).toMatchObject({ text: 'PTU' })
      }
    } finally {
      translator.dispose()
      vi.useRealTimers()
    }
  }
)

it.each(['failed', 'closed'] as const)(
  'preserves original %s plan admission through first sweep and matching force',
  (reason) => {
    const tap = recorder()
    const failure = { accepted: false, reason } as const
    let refuse = false
    tap.sink.tryAppendItem = (identity, body, options) => {
      if (refuse) {
        return failure
      }
      tap.sink.appendItem(identity, body, options)
      return { accepted: true }
    }
    const { sink } = tap
    const translator = createCodexJournalTranslator({ sink, schedule: () => () => {} })
    try {
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'P' }))
      refuse = true
      expect(
        translator.handle(
          notification('item/started', {
            item: { type: 'commandExecution', id: 'tool', command: 'pwd' }
          })
        )
      ).toBe(failure)
      refuse = false
      translator.flush()
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'T' }))
      // First sweep time-skips; matching-thread force must preserve the same terminal object.
      refuse = true
      expect(
        translator.handle(
          notification('item/started', {
            item: { type: 'commandExecution', id: 'tool', command: 'pwd' }
          })
        )
      ).toBe(failure)
    } finally {
      translator.dispose()
    }
  }
)

it.each([10, 100])(
  'bounds plan wake work for %i pending keys, including refusal, force and retirement',
  (count) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const tap = recorder()
    let refuse = false
    let attempts = 0
    let admitted = 0
    tap.sink.tryPublish = () => {
      attempts++
      if (refuse) {
        return { accepted: false, reason: 'backpressure' }
      }
      admitted++
      return { accepted: true }
    }
    let registrations = 0
    let cancellations = 0
    let callbacks = 0
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      schedule: (run, ms) => {
        registrations++
        const timer = setTimeout(() => {
          callbacks++
          run()
        }, ms)
        return () => {
          cancellations++
          clearTimeout(timer)
        }
      }
    })
    const prefix = 'meter-plan-prefix'
    const join = Array.prototype.join
    const iterate = Set.prototype[Symbol.iterator]
    let joins = 0
    let visits = 0
    const joining = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator
    ) {
      if (this[0] === prefix) {
        joins++
      }
      return join.call(this, separator)
    })
    const visiting = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (
      this: Set<unknown>
    ) {
      const iterator = iterate.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (
          !result.done &&
          typeof result.value === 'string' &&
          result.value.includes('meter-plan-')
        ) {
          visits++
        }
        return result
      }
      return iterator
    })
    const delta = (index: number, text: string) =>
      translator.handle(
        notification('item/plan/delta', { itemId: `meter-plan-${index}`, delta: text })
      )
    try {
      // Deliberate control outside the optimized bounds: a public snapshot must be visible to the join meter.
      const control = createAgentSessionDeltaCoalescer({ emit: () => {}, schedule: () => () => {} })
      control.append('control', prefix)
      expect(control.snapshot('control')?.text).toBe(prefix)
      expect(joins).toBeGreaterThan(0)
      expect([...new Set(['meter-plan-control'])]).toEqual(['meter-plan-control'])
      expect(visits).toBeGreaterThan(0)
      visits = 0
      control.dispose()
      joins = 0
      for (let n = 0; n < count; n++) {
        delta(n, prefix)
      }
      expect(joins).toBe(0)
      expect(registrations).toBe(1)
      vi.advanceTimersByTime(60)
      expect(admitted).toBe(count)
      joins = 0
      vi.advanceTimersByTime(40)
      for (let n = 0; n < count; n++) {
        delta(n, 'T')
        delta(n, '')
      }
      vi.advanceTimersByTime(359)
      expect(joins).toBe(0)
      expect(attempts).toBe(count)
      expect(registrations).toBe(3)
      refuse = true
      vi.advanceTimersByTime(1)
      expect(attempts).toBe(2 * count)
      expect(admitted).toBe(count)
      expect(vi.getTimerCount()).toBe(1)
      refuse = false
      vi.advanceTimersByTime(59)
      expect(attempts).toBe(2 * count)
      vi.advanceTimersByTime(1)
      expect(attempts).toBe(3 * count)
      expect(admitted).toBe(2 * count)
      expect(callbacks).toBe(4)
      expect(joins).toBeGreaterThan(0)
      expect(joins).toBeLessThanOrEqual(2 * count)
      expect(visits).toBeLessThanOrEqual(4 * count)
      joins = 0
      for (let n = 0; n < count; n++) {
        delta(n, 'U')
      }
      translator.flush()
      expect(admitted).toBe(3 * count)
      expect(joins).toBeGreaterThan(0)
      expect(joins).toBeLessThanOrEqual(count)
      expect(tap.rows.slice(-count).map((row) => row.body)).toEqual(
        Array.from({ length: count }, () => ({
          kind: 'status',
          presentation: 'plan-document',
          text: `${prefix}TU`
        }))
      )
      translator.dispose()
      const settledAttempts = attempts
      vi.advanceTimersByTime(1000)
      expect(attempts).toBe(settledAttempts)
      expect(vi.getTimerCount()).toBe(0)
      expect(registrations).toBeLessThanOrEqual(6)
      expect(cancellations).toBeLessThanOrEqual(registrations)
      console.info(
        'plan-wake-work',
        JSON.stringify({
          count,
          registrations,
          cancellations,
          callbacks,
          visits,
          attempts,
          admitted
        })
      )
    } finally {
      joining.mockRestore()
      visiting.mockRestore()
      translator.dispose()
      vi.useRealTimers()
    }
  }
)
