import { expect, it, vi } from 'vitest'
import { createLiveTextPublication } from './structured-agent-session-dispatch'
import type { StructuredAgentSessionEventTarget } from './structured-agent-session-event-sink'

it('admits no live operations while nobody views the stream, and resumes for a new viewer', () => {
  const submit = vi.fn(() => ({ accepted: true as const }))
  let viewers = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication reads only this member of its target.
  const target = {
    liveTextReaders: () => (viewers > 0 ? { appends: true } : null)
  } as StructuredAgentSessionEventTarget
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

it('admits no live operations while every viewer is an older one that takes no streamed reply text', () => {
  const submit = vi.fn(() => ({ accepted: true as const }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication reads only this member of its target.
  const target = {
    liveTextReaders: () => ({ appends: false })
  } as StructuredAgentSessionEventTarget
  const publish = createLiveTextPublication(
    submit,
    () => target,
    () => []
  )
  publish()
  expect(submit).not.toHaveBeenCalled()
})
