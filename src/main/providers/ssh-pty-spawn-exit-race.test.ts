import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING_SSH_PTY_SPAWN_EXIT_OPERATIONS,
  MAX_SSH_PTY_SPAWN_EXIT_BYTES_PER_OPERATION,
  MAX_SSH_PTY_SPAWN_EXIT_EVENTS_PER_OPERATION,
  SshPtySpawnExitRaceTracker
} from './ssh-pty-spawn-exit-race'
import { MAX_SSH_RELAY_PTY_ID_BYTES } from './ssh-pty-wire-admission'

describe('SshPtySpawnExitRaceTracker', () => {
  it('matches the same PTY incarnation without fencing a replacement', () => {
    const tracker = new SshPtySpawnExitRaceTracker()
    const operation = tracker.begin()

    tracker.recordExit('pty-1', 'incarnation-old')

    expect(
      tracker.didMatchingExitArrive(operation, {
        id: 'pty-1',
        incarnationId: 'incarnation-current'
      })
    ).toBe(false)
    expect(
      tracker.didMatchingExitArrive(operation, {
        id: 'pty-1',
        incarnationId: 'incarnation-old'
      })
    ).toBe(true)
  })

  it('does not turn malformed incarnation metadata into a wildcard exit', () => {
    const tracker = new SshPtySpawnExitRaceTracker()
    const operation = tracker.begin()

    tracker.recordExit('pty-1', 'x'.repeat(129))

    expect(
      tracker.didMatchingExitArrive(operation, {
        id: 'pty-1',
        incarnationId: 'incarnation-current'
      })
    ).toBe(false)
  })

  it('supports all 50 relay sessions without overflowing', () => {
    const tracker = new SshPtySpawnExitRaceTracker()
    const operation = tracker.begin()
    for (let index = 0; index < 50; index += 1) {
      tracker.recordExit(`pty-${index}`, `incarnation-${index}`)
    }

    expect(
      tracker.didMatchingExitArrive(operation, {
        id: 'pty-49',
        incarnationId: 'incarnation-49'
      })
    ).toBe(true)
    expect(Reflect.get(operation, 'overflowed')).toBe(false)
  })

  it('fails closed and releases retained exits when the count cap is exceeded', () => {
    const tracker = new SshPtySpawnExitRaceTracker()
    const operation = tracker.begin()
    for (let index = 0; index <= MAX_SSH_PTY_SPAWN_EXIT_EVENTS_PER_OPERATION; index += 1) {
      tracker.recordExit(`pty-${index}`, `incarnation-${index}`)
    }

    expect(Reflect.get(operation, 'overflowed')).toBe(true)
    expect(Reflect.get(operation, 'exits')).toHaveLength(0)
    expect(
      tracker.didMatchingExitArrive(operation, {
        id: 'unseen',
        incarnationId: 'unseen-incarnation'
      })
    ).toBe(true)
  })

  it('fails closed when retained exit identifiers exceed the byte cap', () => {
    const tracker = new SshPtySpawnExitRaceTracker()
    const operation = tracker.begin()
    const suffix = 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES - 16)
    const eventBytes = Buffer.byteLength(`pty-000:${suffix}`) + Buffer.byteLength('💥'.repeat(64))
    const eventsToOverflow = Math.floor(MAX_SSH_PTY_SPAWN_EXIT_BYTES_PER_OPERATION / eventBytes) + 1
    expect(eventsToOverflow).toBeLessThan(MAX_SSH_PTY_SPAWN_EXIT_EVENTS_PER_OPERATION)

    for (let index = 0; index < eventsToOverflow; index += 1) {
      tracker.recordExit(`pty-${String(index).padStart(3, '0')}:${suffix}`, '💥'.repeat(64))
    }

    expect(Reflect.get(operation, 'overflowed')).toBe(true)
    expect(Reflect.get(operation, 'retainedBytes')).toBe(0)
  })

  it('rejects before dispatch when concurrent operation tracking is saturated', () => {
    const tracker = new SshPtySpawnExitRaceTracker()
    const admitted = Array.from({ length: MAX_PENDING_SSH_PTY_SPAWN_EXIT_OPERATIONS }, () =>
      tracker.begin()
    )

    expect(() => tracker.begin()).toThrow('ssh_pty_spawn_exit_tracking_capacity')

    for (const operation of admitted) {
      tracker.finish(operation)
    }
  })
})
