import { expect, it } from 'vitest'
import { parseEventTime } from './google-event-time'

it('preserves seconds when interpreting a local calendar time', () => {
  expect(parseEventTime('2026-11-04T10:30:45', 'America/New_York', '--start')).toEqual({
    kind: 'time',
    ms: 1793806245000
  })
})
