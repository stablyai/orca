import { expect, it, vi } from 'vitest'
import { ClaudeJournalBoundDelivery } from './claude-journal-bound-delivery'
import { bindClaudeJournalReadingControl } from './structured/journal/claude-structured-session-journal-control'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionReadingControl
} from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'

function unboundSink() {
  let notify: (() => void) | undefined
  let control: StructuredAgentSessionReadingControl | undefined
  let bound = false
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    onJournalBound: (listener) => {
      notify = listener
      return () => {
        notify = undefined
      }
    },
    journalLinkage: () =>
      bound
        ? {
            epoch: 'test',
            visitItemsWithLinkage: () => {},
            threadGoal: () => null,
            threadGoalSource: () => ({ goal: null, row: null })
          }
        : null,
    bindReadingControl: (next) => {
      control = next
      return () => {}
    }
  }
  return {
    sink,
    bind: () => {
      bound = true
      notify?.()
    },
    pressure: (paused: boolean) => control?.[paused ? 'pauseReading' : 'resumeReading']()
  }
}

it('holds ordered interpretation until binding while preserving independent sink pressure', () => {
  const state = unboundSink()
  let published = false
  const delivery = new ClaudeJournalBoundDelivery(state.sink, () => published)
  const connection = { pauseReading: vi.fn(), resumeReading: vi.fn() }
  bindClaudeJournalReadingControl(state.sink, connection, null, delivery)
  const observed: string[] = []
  delivery.deliver(() => {
    observed.push('start')
    delivery.deliver(() => observed.push('later'))
  })
  delivery.deliver(() => observed.push('terminal'))
  published = true
  delivery.flush()
  state.pressure(true)
  expect(observed).toEqual([])
  state.bind()
  expect(observed).toEqual(['start', 'terminal', 'later'])
  expect(connection.resumeReading).not.toHaveBeenCalled()
  state.pressure(false)
  expect(connection.resumeReading).toHaveBeenCalledOnce()
})

it('terminates the uncommitted prefix on disposal and ignores a late binding', () => {
  const state = unboundSink()
  const delivery = new ClaudeJournalBoundDelivery(state.sink)
  const interpret = vi.fn()
  delivery.deliver(interpret)
  delivery.dispose()
  state.bind()
  delivery.deliver(interpret)
  expect(interpret).not.toHaveBeenCalled()
})

it('fails a bounded unbound prefix instead of silently losing or replaying observations', () => {
  const state = unboundSink()
  const delivery = new ClaudeJournalBoundDelivery(state.sink)
  const failure = vi.fn()
  const interpret = vi.fn()
  delivery.onFailure = failure
  const payload = 'x'.repeat(1024 * 1024)
  expect(() => {
    for (let index = 0; index < 33; index++) {
      delivery.deliver(interpret, payload)
    }
  }).toThrow('capacity exceeded')
  state.bind()
  expect(failure).toHaveBeenCalledOnce()
  expect(interpret).not.toHaveBeenCalled()
})

it('reports binding interpretation failure through its owning failure path', () => {
  const state = unboundSink()
  const delivery = new ClaudeJournalBoundDelivery(state.sink)
  const failure = vi.fn()
  delivery.onFailure = failure
  const error = new Error('invalid saved identity')
  delivery.deliver(() => {
    throw error
  })
  const later = vi.fn()
  delivery.deliver(later)
  expect(() => state.bind()).not.toThrow()
  expect(failure).toHaveBeenCalledWith(error)
  expect(later).not.toHaveBeenCalled()
})
