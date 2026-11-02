import { expect, it } from 'vitest'
import { DaemonPtyInputClosedIncarnations } from './daemon-pty-input-closed-incarnations'

it('keeps a replacement incarnation closed when its report beats its spawn reply', () => {
  const closed = new DaemonPtyInputClosedIncarnations()
  closed.record('pty', 'old')
  // The respawned daemon reports the replacement closed before main reads the reply.
  closed.record('pty', 'replacement')
  closed.sync('pty', { isNew: true, incarnationId: 'replacement' })
  expect(closed.isClosed('pty', 'replacement')).toBe(true)
  expect(closed.isClosed('pty', 'old')).toBe(false)
})

it('forgets a closed incarnation once a reply names a different live one', () => {
  const closed = new DaemonPtyInputClosedIncarnations()
  closed.record('pty', 'old')
  expect(closed.isClosed('pty', 'old')).toBe(true)
  expect(closed.isClosed('pty', undefined)).toBe(true)
  closed.sync('pty', { isNew: true, incarnationId: 'replacement' })
  expect(closed.isClosed('pty', 'replacement')).toBe(false)
  expect(closed.isClosed('pty', 'old')).toBe(false)
  expect(closed.isClosed('pty', undefined)).toBe(false)
})
