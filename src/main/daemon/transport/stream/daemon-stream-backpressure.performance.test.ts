import { describe, expect, it, vi } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import { SessionProducerPause } from '../../sessions/session-producer-pause'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { ConnectedDaemonClient } from '../../server/daemon-client-connections'

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
        producer.release({ resume: false, reason: 'exited' })
      }

      for (let echo = 0; echo < 100; echo++) {
        queued.set('echo', 10 + (echo % 2))
        backpressure.setQueued('client', queued)
      }
      expect(pauseCalls).toBe(exitedCount)
    }
  )

  it.each([10, 100])(
    'terminating sessions get no pause calls across refreshes (%i terminating)',
    (terminatingCount) => {
      let pauseCalls = 0
      const backpressure = new DaemonStreamBackpressure(
        (_sessionId, isPaused) => {
          if (isPaused) {
            pauseCalls += 1
            return 'terminating'
          }
          return undefined
        },
        () => false
      )
      const queued = new Map<string, number>([['echo', 10]])
      for (let i = 0; i < terminatingCount; i++) {
        queued.set(`ending-${i}`, 200 * 1024)
      }
      for (let refresh = 0; refresh < 100; refresh++) {
        queued.set('echo', 10 + (refresh % 2))
        backpressure.setQueued('client', queued)
      }
      expect(pauseCalls).toBe(terminatingCount)
    }
  )

  it.each([10, 100])(
    'unrelated output makes no incarnation lookups with %i paused producers',
    (pausedCount) => {
      let lookups = 0
      const backpressure = new DaemonStreamBackpressure(
        () => true,
        () => false,
        undefined,
        {
          incarnationOf: () => {
            lookups += 1
            return 'live'
          }
        }
      )
      const queued = new Map<string, number>([['echo', 10]])
      for (let i = 0; i < pausedCount; i++) {
        queued.set(`flood-${i}`, 200 * 1024)
      }
      backpressure.setQueued('client', queued)
      const afterPausing = lookups

      for (let echo = 0; echo < 100; echo++) {
        backpressure.noteSessionOutput('echo')
        queued.set('echo', 10 + (echo % 2))
        backpressure.setQueued('client', queued)
      }
      expect(lookups).toBe(afterPausing)
    }
  )

  it.each([10, 100])(
    'detached producers with queued output get no pause calls or lookups on unrelated output (%i detached)',
    (detachedCount) => {
      let pauseCalls = 0
      let lookups = 0
      const producers = new Map<string, SessionProducerPause>()
      const backpressure = new DaemonStreamBackpressure(
        (sessionId, isPaused, onStall) => {
          if (!isPaused) {
            return
          }
          pauseCalls += 1
          const producer = new SessionProducerPause({ pause: () => {}, resume: () => {} })
          producers.set(sessionId, producer)
          return producer.pause('stream', 'detached', onStall)
        },
        () => false,
        undefined,
        {
          incarnationOf: () => {
            lookups += 1
            return 'live'
          }
        }
      )
      const queued = new Map<string, number>([['echo', 10]])
      for (let i = 0; i < detachedCount; i++) {
        queued.set(`detached-${i}`, 200 * 1024)
      }
      for (let echo = 0; echo < 100; echo++) {
        backpressure.noteSessionOutput('echo')
        queued.set('echo', 10 + (echo % 2))
        backpressure.setQueued('client', queued)
      }
      expect(pauseCalls).toBe(detachedCount)
      expect(lookups).toBe(detachedCount)
    }
  )

  it.each([300, 3_000])(
    'a detach and reattach rescan no backlogs with %i queued sessions, and the producer re-pauses',
    (queuedSessions) => {
      let visits = 0
      let pauseCalls = 0
      let viewer: true | 'detached' = true
      const producer = new SessionProducerPause({ pause: () => {}, resume: () => {} })
      const backpressure: DaemonStreamBackpressure = new DaemonStreamBackpressure(
        (_sessionId, isPaused, onStall) => {
          if (!isPaused) {
            return producer.resumeClient('stream')
          }
          pauseCalls += 1
          return producer.pause('stream', viewer, onStall)
        },
        () => {
          visits += 1
          return false
        },
        () => backpressure.refresh()
      )
      const queued = new Map<string, number>([['tui', 200 * 1024]])
      for (let i = 0; i < queuedSessions; i++) {
        queued.set(`quiet-${i}`, 100)
      }
      backpressure.setQueued('client', queued)
      const afterPausing = visits

      viewer = 'detached'
      producer.release({ resume: true, reason: 'released' })
      viewer = true
      producer.noteViewerAttached(true)
      expect(visits).toBe(afterPausing)

      backpressure.setQueued('client', queued)
      expect(pauseCalls).toBe(2)
    }
  )

  it.each(['timer', 'echo'] as const)(
    'a control frame completing while paused earns no lossless resume on the %s flush path',
    (path) => {
      vi.useFakeTimers()
      try {
        // A deep socket that completes writes only when told, so each frame's completion is observable.
        const completions: ((error?: Error | null) => void)[] = []
        const socket = {
          destroyed: false,
          writableLength: 200 * 1024,
          write: (_line: unknown, done: (error?: Error | null) => void) => completions.push(done),
          once: () => socket,
          on: () => socket,
          off: () => socket,
          removeListener: () => socket
        }
        let resumes = 0
        let stall: ((reason: 'input' | 'timeout') => void) | undefined
        const batcher = new DaemonStreamDataBatcher(
          () =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the batcher uses only write, writableLength, destroyed and listener methods, all stubbed above.
            ({ streamSocket: socket, streamFraming: 'ndjson' }) as unknown as Pick<
              ConnectedDaemonClient,
              'streamSocket' | 'streamFraming'
            >,
          {
            onProducerBackpressureChanged: (_sessionId, paused, onStall) => {
              stall = onStall ?? stall
              resumes += paused ? 0 : 1
              return true
            }
          }
        )
        batcher.enqueueControlEvent('client', 'tui', {
          type: 'event',
          event: 'sessionBackgroundMarker',
          sessionId: 'tui',
          payload: { background: false }
        })
        batcher.enqueue('client', 'tui', 'x'.repeat(200 * 1024), {
          flushImmediately: path === 'echo'
        })
        vi.advanceTimersByTime(5)
        completions[0]()
        stall?.('input')
        expect(resumes).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
