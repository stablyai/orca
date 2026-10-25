import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { driveReplyMatrix, replyMatrixGoldenId, replyMatrixSites } from './reply-matrix'
import { replyMatrixNormalResult } from './reply-matrix-normal-result'
import { runRecording } from './run-recording'
import type { RpcClient } from '../../transport/rpc-client'
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
      // Cut over before ready to prove the retiring registry can unsubscribe when its delayed id arrives.
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
      transport.frame(`${CLIENT_EVENTS}#1`, null, {
        ok: true,
        streaming: true,
        result: { type: 'end' }
      })
      expect(() => transport.frame(`${CLIENT_EVENTS}#1`, null, { ok: true })).toThrow(
        'No open stream for frame'
      )
      expect(() =>
        transport.frame(`${CLIENT_EVENTS}#1`, null, {
          ok: false,
          error: { code: 'refused', message: 'gone' }
        })
      ).toThrow('No open stream for frame')
      dispose()
      expect(transport.payloads.map((payload) => payload.name)).toEqual([`${CLIENT_EVENTS}#1`])
      expect(events).toEqual([readyFrame('sub-1').result, changed.result, { type: 'end' }])
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

    // A registry property-read failure never reaches the listener and must remain a scenario error.
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
    // throw undefined requires a presence check; its value alone looks like an empty crash stash.
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
      return recording.checkpoints.at(-1)!.observation.effects
    }
    expect(await drive('never')).toMatchObject([
      {
        name: 'streams-registered-at-teardown',
        value: [{ method: CLIENT_EVENTS, payload: `${CLIENT_EVENTS}#1`, cancelled: false }]
      }
    ])
    expect(await drive('sync')).toEqual([])
    // Due-timer cleanup must match synchronous cleanup rather than appear as an uncancelled stream.
    expect(await drive('timer')).toEqual([])
  })

  it('drives the reply matrix over frames, and matrixes a family that only subscribes', () => {
    const changed = { ok: true, streaming: true, result: { type: 'worktreesChanged' } }
    const base: RecordingScenario = {
      id: 'stream',
      operation: 'op',
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
    expect(replyMatrixSites(base)).toEqual([`${CLIENT_EVENTS}#1@1`, `${CLIENT_EVENTS}#1@2`])
    expect(replyMatrixGoldenId('op', `${CLIENT_EVENTS}#1@2`)).toBe(
      'matrix-op-runtime.clientevents.subscribe-1-2'
    )
    expect(replyMatrixNormalResult('op', [base], `${CLIENT_EVENTS}#1@2`)).toEqual(changed.result)
    const variants = driveReplyMatrix(base, `${CLIENT_EVENTS}#1@1`, readyFrame('sub-1').result)
    const partitions = variants.map((variant) => variant.id.replace('stream.', ''))
    // Frames have no promise, so the two request-rejection partitions do not apply.
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
    // Keep streaming:true on success controls so they route to the same stream.
    expect(replies.get('stream.normal')).toEqual(base.steps[1])
    expect(replies.get('stream.result-absent')).toEqual({
      frame: `${CLIENT_EVENTS}#1`,
      params: null,
      reply: { ok: true, streaming: true }
    })
    expect(replies.get('stream.outer-refused')).toMatchObject({
      reply: { ok: false, error: { code: 'refused' } }
    })
    // Frames stay required after divergence because the registry still routes them to the opening id.
    expect(variants[0]!.steps[3]).toEqual(base.steps[3])
  })
})

const CLIENT_EVENTS = 'runtime.clientEvents.subscribe'

function readyFrame(subscriptionId: string) {
  return { ok: true, streaming: true, result: { type: 'ready', subscriptionId } }
}
