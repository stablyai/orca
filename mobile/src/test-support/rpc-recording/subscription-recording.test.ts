import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { driveReplyMatrix, replyMatrixGoldenId, replyMatrixSites } from './reply-matrix'
import { replyMatrixNormalResult } from './reply-matrix-normal-result'
import { runRecording } from './run-recording'
import type { RecordingScenario } from './recording-scenario'
import type { RecordedValue } from './recording-values'

describe('subscription recordings', () => {
  it('delivers each frame through the session that published its subscribe', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    const events: unknown[] = []
    try {
      const dispose = transport.client.subscribe(CLIENT_EVENTS, null, (result) =>
        events.push(result)
      )
      // Cut over before the stream is ready. The retiring registry keeps the cancelled subscribe
      // precisely so it can unsubscribe once the id arrives, which is the behaviour a transport
      // that routed every frame through the current session would drop on the floor.
      await transport.cutover()
      await clock.flush()
      transport.frame(`${CLIENT_EVENTS}#1`, null, readyFrame('sub-1'))
      transport.frame(`${CLIENT_EVENTS}#2`, null, readyFrame('sub-2'))
      dispose()
      expect(
        transport.payloads.map((payload) => [payload.name, JSON.parse(payload.json).id])
      ).toEqual([
        [`${CLIENT_EVENTS}#1`, 'frame-1'],
        [`${CLIENT_EVENTS}#2`, 'frame-2'],
        ['runtime.clientEvents.unsubscribe#1', 'frame-3'],
        ['runtime.clientEvents.unsubscribe#2', 'frame-4']
      ])
      expect(transport.payloads.map((payload) => JSON.parse(payload.json).params)).toEqual([
        null,
        null,
        { subscriptionId: 'sub-1' },
        { subscriptionId: 'sub-2' }
      ])
      // Only the live generation reaches the listener; the retiring one is fenced by the client.
      expect(events).toEqual([readyFrame('sub-2').result])
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('routes a whole host response at a stream id, and asserts the subscribe params', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    const events: unknown[] = []
    const changed = { ok: true, streaming: true, result: { type: 'worktreesChanged' } }
    try {
      const dispose = transport.client.subscribe(CLIENT_EVENTS, null, (result) =>
        events.push(result)
      )
      transport.frame(`${CLIENT_EVENTS}#1`, null, readyFrame('sub-1'))
      transport.frame(`${CLIENT_EVENTS}#1`, null, changed)
      expect(() => transport.frame(`${CLIENT_EVENTS}#1`, { asserted: 1 }, changed)).toThrow(
        'Subscribe params mismatch'
      )
      expect(() => transport.frame(`${CLIENT_EVENTS}#2`, null, changed)).toThrow(
        'Missing subscription payload'
      )
      // The host's own end of stream, in the two responses it really sends: the `end` event as a
      // streaming frame, then the unary reply the dispatcher sends once the handler returns. The
      // second is what closes the stream here, and the registry reports it to the listener as an
      // error — so the disposer below has no subscription left and publishes no unsubscribe.
      transport.frame(`${CLIENT_EVENTS}#1`, null, {
        ok: true,
        streaming: true,
        result: { type: 'end' }
      })
      transport.frame(`${CLIENT_EVENTS}#1`, null, { ok: true })
      expect(() =>
        transport.frame(`${CLIENT_EVENTS}#1`, null, {
          ok: false,
          error: { code: 'refused', message: 'gone' }
        })
      ).toThrow('No open stream for frame')
      dispose()
      expect(transport.payloads.map((payload) => payload.name)).toEqual([`${CLIENT_EVENTS}#1`])
      expect(events).toEqual([
        readyFrame('sub-1').result,
        changed.result,
        { type: 'end' },
        { type: 'error', message: 'Streaming request ended before it was ready.', error: undefined }
      ])
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('separates a stream listener that dies from a registry that dies before it', async () => {
    const listened: unknown[] = []
    const mount = (client: RpcClient) => {
      const dispose = client.subscribe(CLIENT_EVENTS, null, (result) => {
        listened.push(result)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertion is the behaviour under test — a product listener asserts the frame shape and dies when a reply partition breaks it.
        void (result as { type: string }).type
      })
      return { action: () => {}, state: () => ({}), dispose }
    }
    const scenario = (reply: unknown): RecordingScenario => ({
      id: 'stream-crash',
      operation: 'op',
      version: 1,
      family: 'op',
      sites: [],
      schedules: [],
      steps: [{ frame: `${CLIENT_EVENTS}#1`, params: null, reply }, { checkpoint: 'delivered' }]
    })
    const recording = await runRecording(
      scenario({ ok: true, streaming: true, result: null }),
      ({ client }) => mount(client),
      vitestRecordingScheduler()
    )
    expect(recording.checkpoints[0]!.observation.effects).toMatchObject([
      { name: 'stream-listener-crash', value: { frame: `${CLIENT_EVENTS}#1` } }
    ])
    expect(listened).toEqual([null])

    // A reply the registry cannot read at all: it throws reaching for `error.message` on its way to
    // the listener, so nothing was delivered and there is no recording to keep.
    listened.length = 0
    await expect(
      runRecording(
        scenario({ ok: false }),
        ({ client }) => mount(client),
        vitestRecordingScheduler()
      )
    ).rejects.toThrow("Cannot read properties of undefined (reading 'message')")
    expect(listened).toEqual([])
  })

  it('aborts when the registry throws with nothing stashed, including a thrown undefined', async () => {
    // `throw undefined` is the one registry failure that cannot be told from an empty stash by
    // value alone, so the compare has to ask whether a listener crashed at all.
    const handleResponse = RpcClientStreamRegistry.prototype.handleResponse
    RpcClientStreamRegistry.prototype.handleResponse = () => {
      throw undefined
    }
    try {
      await expect(
        runRecording(
          {
            id: 'registry-throws-undefined',
            operation: 'op',
            version: 1,
            family: 'op',
            sites: [],
            schedules: [],
            steps: [
              { frame: `${CLIENT_EVENTS}#1`, params: null, reply: { ok: true, streaming: true } },
              { checkpoint: 'delivered' }
            ]
          },
          ({ client }) => ({
            action: () => {},
            state: () => ({}),
            dispose: client.subscribe(CLIENT_EVENTS, null, () => {})
          }),
          vitestRecordingScheduler()
        )
      ).rejects.toBeUndefined()
    } finally {
      RpcClientStreamRegistry.prototype.handleResponse = handleResponse
    }
  })

  it('files only a subscribe as an open stream, not the unsubscribe it publishes later', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    try {
      const dispose = transport.client.subscribe(CLIENT_EVENTS, null, () => {})
      transport.frame(`${CLIENT_EVENTS}#1`, null, readyFrame('sub-1'))
      dispose()
      // The unsubscribe is a published payload but never a stream. Filed as one, a frame aimed at it
      // routed at its wire id, matched nothing, recorded nothing and reported success.
      expect(transport.payloads.map((payload) => payload.name)).toEqual([
        `${CLIENT_EVENTS}#1`,
        'runtime.clientEvents.unsubscribe#1'
      ])
      expect(() =>
        transport.frame('runtime.clientEvents.unsubscribe#1', null, readyFrame('sub-1'))
      ).toThrow('Missing subscription payload')
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })
  it('observes a stream the product left registered at teardown, and nothing when it closes', async () => {
    const drive = async (close: 'never' | 'sync' | 'timer'): Promise<RecordedValue> => {
      const recording = await runRecording(
        {
          id: 'teardown-streams',
          operation: 'op',
          version: 1,
          family: 'op',
          sites: [],
          schedules: [],
          steps: [
            { action: 'mount', id: 'mount' },
            { frame: `${CLIENT_EVENTS}#1`, params: null, reply: readyFrame('sub-1') },
            { checkpoint: 'settled' }
          ]
        },
        ({ client }) => {
          let unsubscribe = (): void => {}
          return {
            action: () => {
              unsubscribe = client.subscribe(CLIENT_EVENTS, null, () => {})
            },
            state: () => ({}),
            dispose: () => {
              if (close === 'sync') {
                unsubscribe()
              }
              if (close === 'timer') {
                setTimeout(unsubscribe, 0)
              }
            }
          }
        },
        vitestRecordingScheduler()
      )
      // Teardown is the last checkpoint only when it observed something, which is the point.
      return recording.checkpoints.at(-1)!.observation.effects
    }
    expect(await drive('never')).toMatchObject([
      {
        name: 'streams-registered-at-teardown',
        value: [{ method: CLIENT_EVENTS, payload: `${CLIENT_EVENTS}#1`, cancelled: false }]
      }
    ])
    expect(await drive('sync')).toEqual([])
    // A close deferred to a due 0ms timer is a cleanup that ran. Read before the teardown drain it
    // was byte-identical to the stream above, which is the one thing `cancelled: false` may not mean.
    expect(await drive('timer')).toEqual([])
  })

  it('drives the reply matrix over frames, and matrixes a family that only subscribes', () => {
    const changed = { ok: true, streaming: true, result: { type: 'worktreesChanged' } }
    const base: RecordingScenario = {
      id: 'stream',
      operation: 'op',
      version: 1,
      family: 'op',
      sites: [],
      schedules: [],
      steps: [
        { action: 'mount', id: 'mount' },
        { frame: `${CLIENT_EVENTS}#1`, params: null, reply: readyFrame('sub-1') },
        { checkpoint: 'ready' },
        { frame: `${CLIENT_EVENTS}#1`, params: null, reply: changed },
        { checkpoint: 'changed' }
      ]
    }
    // While the matrix read only completions this family threw its own named failure instead.
    expect(replyMatrixSites(base)).toEqual([`${CLIENT_EVENTS}#1@1`, `${CLIENT_EVENTS}#1@2`])
    expect(replyMatrixGoldenId('op', `${CLIENT_EVENTS}#1@2`)).toBe(
      'matrix-op-runtime.clientevents.subscribe-1-2'
    )
    expect(replyMatrixNormalResult('op', [base], `${CLIENT_EVENTS}#1@2`)).toEqual(changed.result)
    const variants = driveReplyMatrix(base, `${CLIENT_EVENTS}#1@1`, readyFrame('sub-1').result)
    const partitions = variants.map((variant) => variant.id.replace('stream.', ''))
    // Nine of eleven: a frame holds no promise, so neither transport rejection applies to one.
    expect(partitions).toEqual([
      'normal',
      'result-absent',
      'result-null',
      'inner-ok-missing',
      'inner-false-string-error',
      'inner-false-object-error',
      'outer-refused',
      'outer-refused-no-message',
      'method-not-found'
    ])
    const replies = new Map(variants.map((variant) => [variant.id, variant.steps[1]]))
    // The success shapes keep the flag that routes them to the stream; a refusal never had one.
    expect(replies.get('stream.normal')).toEqual(base.steps[1])
    expect(replies.get('stream.result-absent')).toEqual({
      frame: `${CLIENT_EVENTS}#1`,
      params: null,
      reply: { ok: true, streaming: true }
    })
    expect(replies.get('stream.outer-refused')).toMatchObject({
      reply: { ok: false, error: { code: 'refused' } }
    })
    // No `optional` on a downstream frame: the registry routes a streaming response to the id that
    // opened the stream whatever the divergence did, so every scripted frame still lands.
    expect(variants[0]!.steps[3]).toEqual(base.steps[3])
  })
})

const CLIENT_EVENTS = 'runtime.clientEvents.subscribe'

function readyFrame(subscriptionId: string) {
  return { ok: true, streaming: true, result: { type: 'ready', subscriptionId } }
}
