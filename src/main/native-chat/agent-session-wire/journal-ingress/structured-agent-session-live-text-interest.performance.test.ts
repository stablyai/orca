import { expect, it, vi } from 'vitest'
import { createLiveTextPublication } from './structured-agent-session-dispatch'
import type {
  LiveTextReaders,
  StructuredAgentSessionEventTarget
} from './structured-agent-session-event-sink'

// Perf contract: K streams growing in one window cost one live-text read, not K.
it('reads once for every stream that grows in the same window', async () => {
  const submit = vi.fn(() => ({ accepted: true as const }))
  const read = vi.fn(() => [])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication reads only this member of its target.
  const target = {
    liveTextReaders: (): LiveTextReaders => ({ appends: true, shown: true })
  } as StructuredAgentSessionEventTarget
  const publish = createLiveTextPublication(submit, () => target, read)
  for (let stream = 0; stream < 100; stream++) {
    publish()
  }
  expect(read).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  publish()
  expect(read).toHaveBeenCalledTimes(2)
})
