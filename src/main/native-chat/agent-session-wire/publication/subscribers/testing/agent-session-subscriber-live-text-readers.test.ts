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
  // The phone's group skips the row; the older desktop's group, which takes whole rows, does not.
  expect(readers?.groups?.map((group) => [group.shown, group.takes?.('reply')])).toEqual([
    [true, false],
    [false, undefined]
  ])
  const phoneOnly = sessionLiveTextReaders(new Map([['phone', phone]]))
  expect(phoneOnly?.takes?.('reply')).toBe(false)
})
