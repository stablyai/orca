import { resolve } from 'node:path'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { readScenarios } from './scenario-input'
import { materializeScenario } from './scenario-execution-mode'
import { driveReplyMatrix, matrixSites } from './reply-matrix'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { RecordingStreamGuard } from './recording-mismatch'
import { captureArguments, captureValue } from './recording-values'
import { withReplyMeta } from '../bridged-parity/divergence-evidence'
import type { Recording, RecordingScenario } from './recording-scenario'
import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { runRecording } from './run-recording'
import type { RpcClient } from '../../transport/rpc-client'
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
      await transport.dispose()
      await clock.flush()
      transport.causality.assertTransparentCalls()
      transport.causality.close()
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
      await transport.dispose()
      await clock.flush()
      transport.causality.assertTransparentCalls()
      transport.causality.close()
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

  it('preserves a raw registry throw-undefined without classifying it as a listener crash', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    let descriptor: PropertyDescriptor | undefined
    try {
      transport.client.subscribe(CLIENT_EVENTS, null, () => {})
      descriptor = Object.getOwnPropertyDescriptor(
        RpcClientStreamRegistry.prototype,
        'handleResponse'
      )
      if (!descriptor) {
        throw new Error('Missing acquired registry descriptor')
      }
      Object.defineProperty(RpcClientStreamRegistry.prototype, 'handleResponse', {
        ...descriptor,
        value: () => {
          throw undefined
        }
      })
      let outcome: { error: unknown } | undefined
      try {
        transport.frame(`${CLIENT_EVENTS}#1`, null, { ok: true, streaming: true })
      } catch (error) {
        outcome = { error }
      }
      expect(outcome).toEqual({ error: undefined })
      expect(transport.takeListenerCrash()).toBeNull()
    } finally {
      if (descriptor) {
        Object.defineProperty(RpcClientStreamRegistry.prototype, 'handleResponse', descriptor)
      }
      try {
        await transport.dispose()
      } finally {
        try {
          await clock.flush()
        } finally {
          try {
            transport.causality.assertTransparentCalls()
            transport.causality.close()
          } finally {
            clock.stop()
          }
        }
      }
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
      await transport.dispose()
      await clock.flush()
      transport.causality.assertTransparentCalls()
      transport.causality.close()
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
})

const CLIENT_EVENTS = 'runtime.clientEvents.subscribe'

function readyFrame(subscriptionId: string) {
  return { ok: true, streaming: true, result: { type: 'ready', subscriptionId } }
}

const streamRoot = resolve(import.meta.dirname, '../../../..')
const streamInputs = readScenarios(
  resolve(streamRoot, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios

function streamVariants(
  operation: string,
  position: 'first' | 'middle' | 'last',
  mode: 'native' | 'bridge'
) {
  const original = streamInputs.find((input) => input.operation === operation)
  if (!original) {
    throw new Error(`Missing actual stream input: ${operation}`)
  }
  const selected = materializeScenario(original, mode)
  const sites = matrixSites(selected).filter((site) => 'frame' in selected.steps[site.index]!)
  const site = position === 'last' ? sites.at(-1) : sites[position === 'first' ? 0 : 1]
  if (!site) {
    throw new Error('Missing selected original frame')
  }
  const step = selected.steps[site.index]!
  if (
    !('frame' in step) ||
    !step.reply ||
    typeof step.reply !== 'object' ||
    !('result' in step.reply)
  ) {
    throw new Error('Missing original frame result')
  }
  return driveReplyMatrix(selected, site.id, step.reply.result)
}

async function runStreamInput(
  scenario: RecordingScenario,
  mode: 'native' | 'page-original' | 'page-reply-meta'
) {
  const pairs: BridgePortPair<RpcClient>[] = []
  const reads: unknown[] = []
  const actions: string[] = []
  const effects: { name: string; value: unknown }[] = []
  const requests: ReturnType<typeof captureArguments>[] = []
  const mount = pilotMountAdapters(streamRoot, { device: scenario }).adapters[scenario.operation]!
  let outcome: { recording: Recording } | { error: unknown }
  try {
    const recording = await runRecording(
      scenario,
      (context) => {
        const actual = mount({
          ...context,
          effect(name, value) {
            effects.push({ name, value: captureValue(value) })
            context.effect(name, value)
          }
        })
        return {
          ...actual,
          action(...args) {
            actions.push(args[0])
            return actual.action(...args)
          },
          state() {
            const state = actual.state()
            reads.push(captureValue(state))
            return state
          }
        }
      },
      vitestRecordingScheduler(),
      (rpc, observation) => {
        const native: RpcClient = {
          ...rpc,
          sendRequest(...args) {
            requests.push(captureArguments(args))
            return rpc.sendRequest(...args)
          }
        }
        if (mode === 'native') {
          return native
        }
        const pair = createBridgePortPair({
          rpc: native,
          observation: observation.openBridge(),
          ...(mode === 'page-reply-meta' ? { rewriteToPage: withReplyMeta } : {})
        })
        observation.onDispose(() => disposeBridgePortPair(pair))
        pairs.push(pair)
        for (let turn = 0; turn < 4; turn += 1) {
          pair.drainNow()
        }
        return pair.client
      }
    )
    const retainedEffects = recording.checkpoints.at(-1)!.observation.effects
    if (!Array.isArray(retainedEffects)) {
      throw new Error('Missing actual runner effects')
    }
    effects.length = 0
    for (const effect of retainedEffects) {
      if (
        !effect ||
        typeof effect !== 'object' ||
        Array.isArray(effect) ||
        typeof effect.name !== 'string' ||
        !('value' in effect)
      ) {
        throw new Error('Unreadable actual runner effect')
      }
      effects.push({ name: effect.name, value: effect.value })
    }
    outcome = { recording }
  } catch (error) {
    outcome = { error }
  }
  return { outcome, reads, actions, effects, requests, pairs }
}

describe('actual stream result partitions', () => {
  it.each([
    'session.live-worktree-name',
    'session.native-chat-page',
    'notifications.desktop-stream'
  ] as const)(
    'actual %s stream source retains first/last missing-result outcomes and its reached continuation',
    async (operation) => {
      for (const position of ['first', 'last'] as const) {
        for (const mode of ['native', 'page-original', 'page-reply-meta'] as const) {
          const variants = streamVariants(
            operation,
            position,
            mode === 'native' ? 'native' : 'bridge'
          )
          const branch = variants.find((input) => input.lineage?.partition === 'result-absent')
          if (!branch) {
            throw new Error('Missing actual result-absent branch')
          }
          for (const prelude of variants.filter((input) => input.lineage?.role === 'prelude')) {
            const before = await runStreamInput(prelude, mode)
            if ('error' in before.outcome) {
              throw before.outcome.error
            }
            expect(before.outcome.recording.checkpoints.length).toBeGreaterThan(0)
          }
          const run = await runStreamInput(branch, mode)
          const stopsAtMigration =
            mode !== 'native' &&
            position === 'first' &&
            operation !== 'notifications.desktop-stream'
          if (stopsAtMigration) {
            expect('error' in run.outcome).toBe(true)
            if (!('error' in run.outcome)) {
              throw new Error('Missing original failed continuation')
            }
            expect(run.outcome.error).toBeInstanceOf(RecordingStreamGuard)
            if (!(run.outcome.error instanceof RecordingStreamGuard)) {
              throw new Error('Wrong failure boundary')
            }
            expect(run.outcome.error.origin).toBe('scripted-frame-opening')
            expect(run.outcome.error.request).toBe(
              operation === 'session.live-worktree-name'
                ? 'runtime.clientEvents.subscribe#2'
                : 'nativeChat.subscribe#2'
            )
            expect(run.actions.at(-1)).toBe(
              operation === 'session.live-worktree-name' ? 'mount' : 'load-earlier'
            )
            expect(run.actions).not.toContain('unmount')
            expect(run.reads.at(-1)).toMatchObject(
              operation === 'session.live-worktree-name'
                ? { name: 'Feature Work', resolution: 'present', crash: null }
                : {
                    messageIds: [],
                    status: 'error',
                    hasMore: false,
                    error: 'the reply could not be read (unrecognised-message)',
                    crash: null
                  }
            )
            expect(run.requests).toHaveLength(operation === 'session.live-worktree-name' ? 1 : 0)
            expect(run.effects.filter((effect) => effect.name === 'stream-listener-crash')).toEqual(
              []
            )
          } else {
            if ('error' in run.outcome) {
              throw run.outcome.error
            }
            const last = run.outcome.recording.checkpoints.at(-1)!.observation
            if (operation !== 'notifications.desktop-stream') {
              expect(last.settlements).toMatchObject({ cutover: { status: 'fulfilled' } })
            }
            expect(run.actions.at(-1)).toBe(
              operation === 'notifications.desktop-stream' ? 'stop' : 'unmount'
            )
            if (operation === 'session.live-worktree-name') {
              expect(last.state).toMatchObject({
                name: 'Feature Work Renamed',
                resolution: 'present'
              })
              expect(run.requests).toHaveLength(2)
            } else if (operation === 'session.native-chat-page') {
              expect(last.state).toMatchObject({
                messageIds:
                  position === 'first' ? ['m-3', 'm-4', 'm-5'] : ['m-1', 'm-2', 'm-3', 'm-4']
              })
              expect(run.requests).toHaveLength(position === 'first' ? 0 : 1)
            } else {
              expect(last.state).toEqual({ running: false })
              expect(run.requests).toHaveLength(position === 'first' ? 0 : 1)
              const dismissed = run.effects.filter(
                (effect) => effect.name === 'notification-tray.dismiss'
              )
              expect(dismissed.map((effect) => effect.value)).toEqual(
                position === 'last'
                  ? [{ identifier: 'tray-1' }]
                  : mode === 'native'
                    ? [{ identifier: 'tray-2' }]
                    : []
              )
            }
            const crashes = run.effects.filter((effect) => effect.name === 'stream-listener-crash')
            expect(crashes).toHaveLength(
              mode === 'native' && operation !== 'session.live-worktree-name' ? 1 : 0
            )
          }
          if (mode !== 'native') {
            expect(run.pairs).toHaveLength(1)
            const frames = run.pairs[0]!.toShell.map((json) => JSON.parse(json))
            expect(frames.filter((frame) => frame.type === 'subscribe')).toHaveLength(1)
            expect(
              frames.filter((frame) => frame.type === 'cancel' && frame.target === 'subscription')
            ).toHaveLength(1)
          }
        }
      }
    },
    60_000
  )

  it.each(['first', 'middle', 'last'] as const)(
    'actual host refresh preserves each missing-result branch and later real requests (%s)',
    async (position) => {
      const partitions = [
        'normal',
        'result-absent',
        'result-null',
        'inner-ok-missing',
        'inner-false-string-error',
        'inner-false-object-error',
        'outer-refused',
        'outer-refused-no-message',
        'method-not-found'
      ]
      for (const mode of ['native', 'page-original', 'page-reply-meta'] as const) {
        const variants = streamVariants(
          'worktree.host-refresh',
          position,
          mode === 'native' ? 'native' : 'bridge'
        )
        expect(
          variants
            .filter((input) => input.lineage?.role !== 'prelude')
            .map((input) => input.lineage?.partition)
        ).toEqual(partitions)
        for (const branch of variants.filter((input) => input.lineage?.role !== 'prelude')) {
          for (const prelude of variants.filter((input) => input.lineage?.role === 'prelude')) {
            const before = await runStreamInput(prelude, mode)
            if ('error' in before.outcome) {
              throw before.outcome.error
            }
            expect(before.outcome.recording.checkpoints.length).toBeGreaterThan(0)
          }
          const run = await runStreamInput(branch, mode)
          const partition = branch.lineage!.partition!
          const failed = mode !== 'native' && partition === 'result-absent' && position !== 'last'
          const outer = ['outer-refused', 'outer-refused-no-message', 'method-not-found'].includes(
            partition
          )
          const expected =
            partition === 'normal'
              ? [5, 4]
              : outer && position !== 'last'
                ? [2, 2]
                : failed
                  ? [2, 2]
                  : position === 'middle'
                    ? [4, 4]
                    : [4, 3]
          if (failed) {
            expect('error' in run.outcome).toBe(true)
            if (!('error' in run.outcome) || !(run.outcome.error instanceof RecordingStreamGuard)) {
              throw new Error('Missing actual stopped opening')
            }
            expect(run.outcome.error.origin).toBe('scripted-frame-opening')
            expect(run.outcome.error.request).toBe('runtime.clientEvents.subscribe#2')
            expect(run.actions).toEqual(['start'])
          } else {
            if ('error' in run.outcome) {
              throw run.outcome.error
            }
            expect(run.actions).toEqual(['start', 'stop'])
            expect(run.outcome.recording.checkpoints.at(-1)!.observation.settlements).toMatchObject(
              { cutover: { status: 'fulfilled' } }
            )
            expect(run.outcome.recording.checkpoints.at(-1)!.observation.state).toEqual({
              fetchWorktrees: expected[0],
              fetchRepoMetadata: expected[1],
              running: false
            })
          }
          if (!('error' in run.outcome)) {
            const payloads = run.outcome.recording.checkpoints.at(-1)!.observation.payloads
            if (!Array.isArray(payloads)) {
              throw new Error('Missing actual refresh stream/control bytes')
            }
            const frames = payloads.map((row) => {
              if (
                !row ||
                typeof row !== 'object' ||
                Array.isArray(row) ||
                typeof row.json !== 'string'
              ) {
                throw new Error('Missing actual refresh frame')
              }
              return JSON.parse(row.json)
            })
            const unsubscribeIds = outer
              ? position === 'last'
                ? ['sub-1']
                : ['sub-2']
              : partition === 'normal' || position === 'middle'
                ? ['sub-1', 'sub-2']
                : position === 'first'
                  ? ['sub-2']
                  : ['sub-1']
            expect(frames.filter((frame) => frame.method.endsWith('.subscribe'))).toEqual([
              {
                id: 'frame-1',
                deviceToken: 'recording-device',
                method: CLIENT_EVENTS,
                params: null
              },
              {
                id: 'frame-2',
                deviceToken: 'recording-device',
                method: CLIENT_EVENTS,
                params: null
              }
            ])
            expect(
              frames
                .filter((frame) => frame.method.endsWith('.unsubscribe'))
                .map((frame) => frame.params)
            ).toEqual(unsubscribeIds.map((subscriptionId) => ({ subscriptionId })))
            expect(frames).toHaveLength(2 + unsubscribeIds.length)
          }
          expect(run.requests).toEqual([])
          expect(run.effects.filter((effect) => effect.name === 'fetchWorktrees')).toHaveLength(
            expected[0]!
          )
          expect(run.effects.filter((effect) => effect.name === 'fetchRepoMetadata')).toHaveLength(
            expected[1]!
          )
          if (mode !== 'native') {
            const posted = run.pairs[0]!.toShell.map((json) => JSON.parse(json))
            expect(posted.filter((frame) => frame.type === 'subscribe')).toHaveLength(1)
            expect(posted.filter((frame) => frame.type === 'request')).toEqual([])
            expect(
              posted.filter((frame) => frame.type === 'cancel' && frame.target === 'subscription')
            ).toHaveLength(1)
          }
        }
        if (mode !== 'native' && position !== 'last') {
          const entered: string[] = []
          for (const segment of variants) {
            entered.push(segment.lineage!.role ?? segment.lineage!.partition!)
            const run = await runStreamInput(segment, mode)
            if ('error' in run.outcome) {
              expect(segment.lineage!.partition).toBe('result-absent')
              expect(run.outcome.error).toBeInstanceOf(RecordingStreamGuard)
              expect(run.actions).toEqual(['start'])
              expect(run.reads.at(-1)).toEqual({
                fetchWorktrees: 2,
                fetchRepoMetadata: 2,
                running: true
              })
              break
            }
          }
          expect(entered).toEqual(['prelude', 'normal', 'result-absent'])
        }
      }
    },
    60_000
  )
})
