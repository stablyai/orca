import { expect, it, vi } from 'vitest'
import { createLiveTextPublication } from './structured-agent-session-dispatch'
import type { StructuredAgentSessionEventTarget } from './structured-agent-session-event-sink'

it('admits no live operations while nobody views the stream, and resumes for a new viewer', () => {
  const submit = vi.fn(() => ({ accepted: true as const }))
  let viewers = 0
  const target = { hasLiveTextSubscribers: () => viewers > 0 } as StructuredAgentSessionEventTarget
  const publish = createLiveTextPublication(
    submit,
    () => target,
    () => []
  )
  for (let window = 0; window < 1000; window++) {
    publish()
  }
  expect(submit).not.toHaveBeenCalled()
  viewers = 1
  publish()
  expect(submit).toHaveBeenCalledTimes(1)
})
