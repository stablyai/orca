import { describe, expect, it } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import { SessionProducerPause } from '../../sessions/session-producer-pause'

// Guards #51089: per-session pausing must not re-send pauses to paused floods or exited sessions on each unrelated update.
describe('DaemonStreamBackpressure pause calls', () => {
  it.each([300, 3_000])(
    'an unrelated update makes no pause calls with %i quiet sessions and 10 paused floods',
    (quietSessions) => {
      let pauseCalls = 0
      const backpressure = new DaemonStreamBackpressure(
        () => {
          pauseCalls += 1
        },
        () => false
      )
      const queued = new Map<string, number>()
      for (let i = 0; i < quietSessions; i++) {
        queued.set(`quiet-${i}`, 100)
      }
      for (let i = 0; i < 10; i++) {
        queued.set(`flood-${i}`, 200 * 1024)
      }
      backpressure.setQueued('client', queued)
      expect(pauseCalls).toBe(10)

      queued.set('quiet-0', 101)
      backpressure.setQueued('client', queued)
      expect(pauseCalls).toBe(10)
    }
  )

  it.each([10, 100])(
    'exited sessions with queued final output get no pause calls on unrelated updates (%i exited)',
    (exitedCount) => {
      let pauseCalls = 0
      const exited = new Set<string>()
      const producers = new Map<string, SessionProducerPause>()
      const producerFor = (sessionId: string): SessionProducerPause => {
        let producer = producers.get(sessionId)
        if (!producer) {
          producer = new SessionProducerPause({ pause: () => {}, resume: () => {} })
          producers.set(sessionId, producer)
        }
        return producer
      }
      const backpressure = new DaemonStreamBackpressure(
        (sessionId, isPaused, onStall) => {
          if (!isPaused) {
            producerFor(sessionId).resumeClient('stream')
            return
          }
          pauseCalls += 1
          return exited.has(sessionId)
            ? 'exited'
            : producerFor(sessionId).pause('stream', true, onStall)
        },
        () => false
      )
      const queued = new Map<string, number>([['echo', 10]])
      for (let i = 0; i < exitedCount; i++) {
        queued.set(`gone-${i}`, 200 * 1024)
      }
      backpressure.setQueued('client', queued)
      // Each producer exits while paused; its final output stays queued.
      for (const [sessionId, producer] of producers) {
        exited.add(sessionId)
        producer.release({ resume: false })
      }

      for (let echo = 0; echo < 100; echo++) {
        queued.set('echo', 10 + (echo % 2))
        backpressure.setQueued('client', queued)
      }
      expect(pauseCalls).toBe(exitedCount)
    }
  )
})
