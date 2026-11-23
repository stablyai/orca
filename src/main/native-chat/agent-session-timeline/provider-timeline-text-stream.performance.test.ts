import { expect, it } from 'vitest'
import {
  providerTimelineLiveText,
  type ProviderTimelineStream
} from './provider-timeline-text-stream'

// Perf contract: a provider timeline's live row is built once per growth of its text, so every
// reader of a window compares against the same row instead of a fresh copy of the whole reply.
it('reads the same live row while its text is unchanged, and a new one once it grows', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the live read uses only these fields.
  const stream = {
    channel: 'assistant',
    closing: false,
    stoppedIn: null,
    committed: {
      epoch: 'epoch-1',
      placement: { itemId: 'reply', revision: 1, sequence: 3, observedAt: 1 }
    }
  } as unknown as ProviderTimelineStream
  let text = 'The reply so far'
  const read = () => providerTimelineLiveText(stream, 'epoch-1', () => ({ text }))[0]
  const first = read()
  expect(read()).toBe(first)
  text = `${text} and more`
  const grown = read()
  expect(grown).not.toBe(first)
  expect(grown).toMatchObject({ body: { blocks: [{ text }] } })
  expect(read()).toBe(grown)
})
