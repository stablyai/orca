import { expect, it } from 'vitest'
import { sessionLiveTextReaders } from '../agent-session-subscriber-live-text-readers'
import type { Subscriber } from '../agent-session-subscribe-input'

const subscriber = (fields: Partial<Subscriber>): Subscriber =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the readers read only these fields.
  ({ id: 'reader', sessionId: 'session', ...fields }) as Subscriber

it('still reads a row an older reader takes, beside a shown phone that no longer takes it', () => {
  const phone = subscriber({
    id: 'phone',
    liveTextViewer: 'phone',
    liveTextShown: true,
    holdsTextBase: () => true,
    liveShortened: new Set(['reply'])
  })
  const olderDesktop = subscriber({ id: 'desktop' })
  const readers = sessionLiveTextReaders(
    new Map([
      ['phone', phone],
      ['desktop', olderDesktop]
    ])
  )
  expect(readers?.shown).toBe(true)
  expect(readers?.takes?.('reply')).not.toBe(false)
  const phoneOnly = sessionLiveTextReaders(new Map([['phone', phone]]))
  expect(phoneOnly?.takes?.('reply')).toBe(false)
})
