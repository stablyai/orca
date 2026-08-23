import { expect, it, vi } from 'vitest'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'

it('keeps a late-bound operation the owner of the exit it fenced', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const bound = tracker.begin('pty-1')
  const late = tracker.begin()

  tracker.recordExit('pty-1', 'incarnation-old', publish)
  tracker.bind(late, 'pty-1')
  expect(tracker.classifyPendingExit(late, { id: 'pty-1', incarnationId: 'incarnation-new' })).toBe(
    null
  )
  tracker.finish(late)
  tracker.finish(bound)

  expect(publish).not.toHaveBeenCalled()
})

it('does not release a quarantined exit when one operation finishes twice', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const first = tracker.begin('pty-1')
  tracker.begin('pty-1')

  tracker.recordExit('pty-1', 'incarnation-old', publish)
  tracker.finish(first)
  tracker.finish(first)

  expect(publish).not.toHaveBeenCalled()
})

it('releases a held exit when a late binder without an incarnation cannot attribute it', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const holder = tracker.begin('pty-1')
  const late = tracker.begin()

  // Relays that send no incarnation id leave both sides unidentified, so nothing is attributable.
  tracker.recordExit('pty-1', undefined, publish)
  tracker.bind(late, 'pty-1')
  expect(tracker.classifyPendingExit(late, { id: 'pty-1' })).toBe('unverifiable')
  tracker.finish(late)
  tracker.finish(holder)

  expect(publish).toHaveBeenCalledOnce()
})

it('releases a held exit when a late binder attaches without an incarnation', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const holder = tracker.begin('pty-1')
  const late = tracker.begin()

  tracker.recordExit('pty-1', 'incarnation-old', publish)
  tracker.bind(late, 'pty-1')
  expect(tracker.classifyPendingExit(late, { id: 'pty-1' })).toBe('unverifiable')
  tracker.finish(late)
  tracker.finish(holder)

  expect(publish).toHaveBeenCalledOnce()
})

it('publishes an unheld exit once even after a late binder attributes it', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const late = tracker.begin()

  // The notification router publishes whatever the tracker does not take ownership of.
  if (!tracker.recordExit('pty-1', 'incarnation-1', publish)) {
    publish()
  }
  tracker.bind(late, 'pty-1')
  expect(tracker.classifyPendingExit(late, { id: 'pty-1', incarnationId: 'incarnation-1' })).toBe(
    'exited'
  )
  tracker.finish(late)

  expect(publish).toHaveBeenCalledOnce()
})

it('cannot recall an exit released before a late binder attributes it', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const holder = tracker.begin('pty-1')
  const late = tracker.begin()

  tracker.recordExit('pty-1', 'incarnation-1', publish)
  // holders reaches zero before the late binder reaches its verdict, so the exit escapes.
  tracker.finish(holder)
  expect(publish).toHaveBeenCalledOnce()

  tracker.bind(late, 'pty-1')
  expect(tracker.classifyPendingExit(late, { id: 'pty-1', incarnationId: 'incarnation-1' })).toBe(
    'exited'
  )
  tracker.finish(late)

  expect(publish).toHaveBeenCalledOnce()
})
