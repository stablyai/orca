import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DaemonTransientReader } from './daemon-transient-reader'
import { attachStreamEventReader } from './daemon-client-ndjson-readers'
import { streamFramesFor } from './daemon-stream-data-split'
import type { DaemonEvent, TerminalObservationEvent } from './daemon-stream-events'
import type { DaemonCreateOrAttachResult } from './daemon-create-or-attach-result'

describe('ordered terminal observation reader', () => {
  it.each(['ndjson', 'binary-v1'] as const)(
    'binds %s before effects without waiting for the RPC result',
    async (streamFraming) => {
      const output: DaemonEvent[] = []
      const admission = new DaemonTransientReader('stream', (event) => output.push(event))
      const subscription = admission.begin()!
      const observation = (revision: number): TerminalObservationEvent => ({
        type: 'event',
        event: 'terminalObservation',
        ...subscription,
        incarnationId: 'incarnation',
        epoch: 0,
        payload:
          revision === 0
            ? {
                kind: 'install',
                revision,
                rawEndSeq: 0,
                current: {
                  command: 'unseen',
                  commandRevision: 0,
                  mode2031: 'unknown',
                  modeRevision: 0
                }
              }
            : { kind: 'observation', revision, rawEndSeq: 12, fact: { kind: 'command-started' } }
      })
      const frames = streamFramesFor(streamFraming)
      const socket = new Socket()
      const reader = attachStreamEventReader(
        socket,
        { streamFraming, remainder: Buffer.alloc(0) },
        (event) => admission.accept(event)
      )
      const send = (event: DaemonEvent): void => {
        socket.push(Buffer.from(frames.control(event)))
      }
      const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
      const result: DaemonCreateOrAttachResult = {
        isNew: false,
        snapshot: null,
        pid: 1,
        shellState: 'ready',
        incarnationId: 'incarnation',
        transients: { ...subscription, sessionId: 'actual-owner' }
      }
      try {
        send(observation(0))
        await tick()
        expect(output).toEqual([])
        send({
          type: 'event',
          event: 'data',
          sessionId: 'actual-owner',
          payload: {
            data: '',
            rawLength: 0,
            subscriptionId: subscription.subscriptionId
          }
        })
        send({
          type: 'event',
          event: 'data',
          sessionId: 'actual-owner',
          payload: { data: 'paint' }
        })
        send(observation(1))
        await tick()
        expect(output.map((event) => event.event)).toEqual([
          'terminalObservation',
          'data',
          'terminalObservation'
        ])
        expect(output.every((event) => event.sessionId === 'actual-owner')).toBe(true)
        admission.finish(subscription.subscriptionId, result)
        expect(output).toHaveLength(3)
        send({ ...observation(2), streamId: 'previous-stream' })
        send({ ...observation(2), incarnationId: 'previous-incarnation' })
        send({ ...observation(2), epoch: -1 })
        send(observation(3)) // Missing revision 2 makes current evidence unconfirmed.
        send(observation(4))
        await tick()
        expect(output).toHaveLength(3)
        const reinstall = observation(0)
        if (reinstall.payload.kind !== 'install') {
          throw new Error('Expected install')
        }
        send({
          ...reinstall,
          epoch: 1,
          payload: { ...reinstall.payload, revision: 4, rawEndSeq: 12 }
        })
        await tick()
        expect(output).toHaveLength(4)
        admission.finish(subscription.subscriptionId, {
          ...result,
          transients: { ...subscription, sessionId: 'conflicting-owner' }
        })
        send({ ...observation(5), epoch: 1 })
        await tick()
        expect(output).toHaveLength(4)
      } finally {
        reader.detach()
        socket.destroy()
      }
    }
  )
  it('reuses physical slots at capacity through failed aliases, reordered results and lifetime end', () => {
    const current = new Map<string, string>()
    const events: DaemonEvent[] = []
    const reader = new DaemonTransientReader(
      'stream',
      (event) => events.push(event),
      (id) => current.get(id)
    )
    const install = (
      subscription: ReturnType<typeof reader.begin>,
      incarnationId: string,
      revision = 0
    ): TerminalObservationEvent => ({
      type: 'event',
      event: 'terminalObservation',
      ...subscription,
      incarnationId,
      epoch: 0,
      payload: {
        kind: 'install',
        revision,
        rawEndSeq: revision,
        current: {
          command: 'running',
          commandRevision: revision,
          mode2031: 'unknown',
          modeRevision: 0
        }
      }
    })
    const result = (subscription: ReturnType<typeof reader.begin>, incarnationId = 'inc-0') => ({
      incarnationId,
      transients: { ...subscription, sessionId: current.get(incarnationId) }
    })
    const predecessor = reader.begin()
    for (let i = 0; i < 4096; i++) {
      const subscription = i === 0 ? predecessor : reader.begin()
      current.set(`inc-${i}`, `session-${i}`)
      reader.accept(install(subscription, `inc-${i}`))
    }
    expect(reader.retained().bindings).toBe(4096)
    const before = reader.retained()
    const failed = reader.begin()
    reader.finish(failed.subscriptionId, undefined)
    expect(reader.retained()).toEqual(before)
    const fact = (subscription: typeof predecessor, revision: number): void =>
      reader.accept({
        ...install(subscription, 'inc-0', revision),
        payload: {
          kind: 'observation',
          revision,
          rawEndSeq: revision,
          fact: { kind: 'command-started' }
        }
      })
    const a = reader.begin(),
      b = reader.begin()
    reader.finish(b.subscriptionId, result(b)) // A control result never cuts off queued predecessor facts.
    events.length = 0
    fact(predecessor, 1)
    reader.accept(install(a, 'inc-0', 1))
    fact(a, 2)
    reader.accept(install(b, 'inc-0', 2))
    reader.finish(a.subscriptionId, result(a)) // Late alias result cannot restore A's subscription.
    fact(a, 3)
    fact(b, 3)
    expect(
      events.map((event) =>
        event.event === 'terminalObservation' ? event.payload.kind : event.event
      )
    ).toEqual(['observation', 'install', 'observation', 'install', 'observation'])
    expect(reader.retained()).toEqual(before)
    reader.accept({
      type: 'event',
      event: 'exit',
      sessionId: 'session-0',
      payload: { code: 0, incarnationId: 'inc-0' }
    })
    current.delete('inc-0')
    reader.finish(b.subscriptionId, result(b))
    expect(reader.retained().bindings).toBe(4095)
    const successor = reader.begin()
    current.set('successor', 'session-0') // Actual adapter publishes only after its raced-exit check.
    reader.finish(successor.subscriptionId, result(successor, 'successor'))
    expect(reader.retained().bindings).toBe(4095) // No result-before-install placeholder journal.
    reader.accept(install(successor, 'successor'))
    expect(events.at(-1)).toMatchObject({ sessionId: 'session-0', payload: { kind: 'install' } })
    reader.detach('session-0')
    reader.finish(successor.subscriptionId, result(successor, 'successor'))
    expect(reader.retained().bindings).toBe(4095)
    expect(reader.retained().bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    reader.dispose()
    reader.finish(successor.subscriptionId, result(successor, 'successor'))
    reader.accept(install(successor, 'successor'))
    expect(reader.retained()).toEqual({ bindings: 0, bytes: 4096 })
  })
})
