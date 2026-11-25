import { expect, it } from 'vitest'
import { ConnectorPostAttempts } from './connector-post-attempts'

// A refused post never stands as the chat's own answer, and taking it back never erases a later one.
it('takes back only a refused attempt, leaving earlier and later ones', () => {
  let now = 10
  const attempts = new ConnectorPostAttempts(() => now)
  attempts.attempted('chat')
  now = 20
  const refused = attempts.attempted('chat')
  refused()
  expect([attempts.since('chat', 10), attempts.since('chat', 15)]).toEqual([true, false])
  now = 30
  const first = attempts.attempted('chat')
  now = 40
  const second = attempts.attempted('chat')
  first()
  second()
  expect(attempts.since('chat', 25)).toBe(false)
  now = 50
  const late = attempts.attempted('chat')
  now = 60
  attempts.attempted('chat')
  late()
  expect(attempts.since('chat', 55)).toBe(true)
  // A later turn's post never counts against an earlier turn that ended before it.
  expect(attempts.since('chat', 45, 55)).toBe(false)
  // A queued post checked again is the same post: refusing it takes back the first try too.
  now = 70
  attempts.attempted('chat', 'post-1')
  now = 80
  attempts.attempted('chat', 'post-1')()
  expect(attempts.since('chat', 65)).toBe(false)
})
