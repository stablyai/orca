import { expect, it } from 'vitest'
import { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'

it('Stop cancels both an outside-lane preparation and an option wait without touching another session', () => {
  const waits = new StructuredAgentSessionAcquireAborts()
  const preparation = waits.begin('s')
  const option = waits.begin('s')
  const other = waits.begin('other')
  waits.abort('s', 'stopped')
  expect(preparation.signal.aborted).toBe(true)
  expect(option.signal.aborted).toBe(true)
  expect(other.signal.aborted).toBe(false)
  preparation.end()
  option.end()
  const next = waits.begin('s')
  waits.abort('s', 'stopped again')
  expect(next.signal.aborted).toBe(true)
  next.end()
  other.end()
})

it('completion removes only its own wait and quit cancels existing and future waits', () => {
  const waits = new StructuredAgentSessionAcquireAborts()
  const preparation = waits.begin('s')
  const option = waits.begin('s')
  preparation.end()
  waits.abortAll('quit')
  expect(preparation.signal.aborted).toBe(false)
  expect(option.signal.aborted).toBe(true)
  const next = waits.begin('other')
  expect(next.signal.aborted).toBe(true)
  option.end()
  next.end()
})
