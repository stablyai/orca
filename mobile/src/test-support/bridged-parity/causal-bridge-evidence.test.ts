import { describe, expect, it } from 'vitest'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import type { AttemptObservation } from '../rpc-recording/recording-causality'
import type {
  MountAdapter,
  Recording,
  RecordingScenario
} from '../rpc-recording/recording-scenario'
import { materializeScenario } from '../rpc-recording/scenario-execution-mode'
import { runRecording } from '../rpc-recording/run-recording'
import { captureValue } from '../rpc-recording/recording-values'
import { vitestRecordingScheduler } from '../rpc-recording/vitest-recording-scheduler'
import { withReplyMeta } from './divergence-evidence'

const params = { repo: 'id:repo', ownerRepo: { owner: 'fork', repo: 'repo', host: 'github.test' } }
const options = {
  envelope: {
    executionHost: { kind: 'server', hostId: 'server-a' },
    expectedRuntimeSource: { runtimeId: 'final-runtime', sourceId: 'final-server' }
  }
}
const capable = {
  ok: true,
  result: {
    runtimeId: 'first-hop-runtime',
    hostDescriptor: { installationId: 'first-hop-desktop' },
    capabilities: ['github.exact-work-item-target.v1']
  }
}
const base: RecordingScenario = {
  id: 'causal-contract',
  operation: 'causal-contract',
  family: 'causal-contract',
  sites: [],
  schedules: [],
  bridgeOperations: [
    {
      request: 'github.listLabels#1',
      probeSite: 'github.listLabels#1.native-1',
      methods: ['status.get', 'github.listLabels']
    }
  ],
  steps: [
    { action: 'start', id: 'start' },
    {
      transport: 'native',
      complete: 'github.listLabels#1',
      site: 'github.listLabels#1',
      params,
      reply: { ok: true, result: ['label'] }
    },
    {
      transport: 'bridge',
      complete: 'github.listLabels#1.native-1',
      site: 'github.listLabels#1.native-1',
      bridgeSite: true,
      params: undefined,
      reply: capable
    },
    {
      transport: 'bridge',
      complete: 'github.listLabels#1.native-2',
      site: 'github.listLabels#1',
      params,
      reply: { ok: true, result: ['label'] }
    },
    { checkpoint: 'settled' }
  ]
}
const mount: MountAdapter = ({ client, effect }) => {
  let labels: unknown = null
  return {
    action: () =>
      client.sendRequest('github.listLabels', params, options).then((reply) => {
        if (!reply.ok) {
          throw new Error(reply.error.message)
        }
        labels = reply.result
        effect('labels', labels)
      }),
    state: () => ({ labels }),
    dispose: () => {}
  }
}
async function runInput(
  input: RecordingScenario,
  adapter: MountAdapter,
  mode: 'native' | 'page' | 'reply-meta'
) {
  const pairs: BridgePortPair<RpcClient>[] = []
  const recording = await runRecording(
    materializeScenario(input, mode === 'native' ? 'native' : 'bridge'),
    adapter,
    vitestRecordingScheduler(),
    mode === 'native'
      ? undefined
      : (rpc, observation) => {
          const pair = createBridgePortPair({
            rpc,
            observation: observation.openBridge(),
            rewriteToPage: mode === 'reply-meta' ? withReplyMeta : undefined
          })
          pairs.push(pair)
          observation.onDispose(() => disposeBridgePortPair(pair))
          for (let turn = 0; turn < 4; turn++) {
            pair.drainNow()
          }
          return pair.client
        }
  )
  return { recording, pairs }
}
function terminal(recording: Recording) {
  return recording.checkpoints.at(-1)!.observation
}
function physical(recording: Recording) {
  const rows = terminal(recording).payloads
  if (!Array.isArray(rows)) {
    throw new Error('Missing physical requests')
  }
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.json !== 'string') {
      throw new Error('Missing serialized request')
    }
    return { ...row, frame: JSON.parse(row.json) }
  })
}
function senders(recording: Recording): AttemptObservation[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner clones the actual transport attempt array without re-encoding it.
  return terminal(recording).sender as unknown as AttemptObservation[]
}

describe('actual page, host and tracker contracts', () => {
  it('keeps two equal silent streams attached through two real migrations and disposes their actual subscriptions', async () => {
    const shared = { topic: 'same' }
    for (const mode of ['native', 'page', 'reply-meta'] as const) {
      const callbacks = [
        () => {
          throw new Error('Silent A received an event')
        },
        () => {
          throw new Error('Silent B received an event')
        }
      ]
      const adapter: MountAdapter = ({ client }) => {
        const releases: (() => void)[] = []
        let labels: unknown = null
        return {
          action: (name) => {
            if (name === 'start') {
              return client.sendRequest('github.listLabels', params, options).then((reply) => {
                if (!reply.ok) {
                  throw new Error(reply.error.message)
                }
                labels = reply.result
              })
            }
            if (name === 'streams') {
              releases.push(
                client.subscribe('runtime.clientEvents.subscribe', shared, callbacks[0]),
                client.subscribe('runtime.clientEvents.subscribe', shared, callbacks[1])
              )
            } else if (name === 'stop') {
              for (const release of releases.splice(0)) {
                release()
              }
            } else {
              throw new Error(`Unknown action ${name}`)
            }
          },
          state: () => ({ labels, subscriptions: releases.length }),
          dispose: () => {
            for (const release of releases.splice(0)) {
              release()
            }
          }
        }
      }
      const input: RecordingScenario = {
        ...base,
        id: 'silent-equal-stream-cutover',
        operation: 'stream-opening-contract',
        family: 'stream-opening-contract',
        steps: [
          ...base.steps,
          { action: 'streams', id: 'streams' },
          { checkpoint: 'opened' },
          { action: 'cutover', id: 'cutover' },
          { checkpoint: 'reopened' },
          { action: 'cutover', id: 'second-cutover' },
          { checkpoint: 'reopened-again' },
          { action: 'stop', id: 'stop' },
          { checkpoint: 'stopped' }
        ]
      }
      const { recording, pairs } = await runInput(input, adapter, mode)
      const openings = physical(recording)
      const frames = openings.map((row) => row.frame)
      const offset = mode === 'native' ? 1 : 2
      expect(frames.slice(0, offset).map((frame) => frame.method)).toEqual(
        mode === 'native' ? ['github.listLabels'] : ['status.get', 'github.listLabels']
      )
      expect(frames.slice(offset)).toEqual(
        Array.from({ length: 6 }, (_, index) => ({
          id: `frame-${offset + index + 1}`,
          deviceToken: 'recording-device',
          method: 'runtime.clientEvents.subscribe',
          params: shared
        }))
      )
      for (const [checkpoint, subscriptions, count] of [
        ['opened', 2, 2],
        ['reopened', 2, 4],
        ['reopened-again', 2, 6],
        ['stopped', 0, 6]
      ] as const) {
        const observation = recording.checkpoints.find(
          (entry) => entry.id === checkpoint
        )!.observation
        expect(observation.state).toEqual({ labels: ['label'], subscriptions })
        expect(Array.isArray(observation.payloads) && observation.payloads.length).toBe(
          offset + count
        )
      }
      expect(terminal(recording).settlements).toMatchObject({
        start: { status: 'fulfilled' },
        streams: { status: 'fulfilled' },
        cutover: { status: 'fulfilled' },
        'second-cutover': { status: 'fulfilled' },
        stop: { status: 'fulfilled' }
      })
      const effects = terminal(recording).effects
      if (!Array.isArray(effects)) {
        throw new Error('Missing actual teardown effects')
      }
      expect(
        effects.flatMap((effect) =>
          effect !== null &&
          typeof effect === 'object' &&
          !Array.isArray(effect) &&
          effect.name === 'streams-registered-at-teardown'
            ? [effect.value]
            : []
        )
      ).toEqual([
        openings.slice(offset).map((opening) => ({
          method: opening.frame.method,
          payload: opening.name,
          cancelled: true
        }))
      ])
      if (mode !== 'native') {
        const sent = pairs[0].readToShell()
        const opens = sent.filter((frame) => frame.type === 'subscribe')
        const closes = sent.filter(
          (frame) => frame.type === 'cancel' && frame.target === 'subscription'
        )
        expect(opens).toHaveLength(2)
        expect(closes).toHaveLength(2)
        expect(closes.map((frame) => frame.id)).toEqual(opens.map((frame) => frame.id))
        expect(pairs[0].readToPage().filter((frame) => frame.type === 'event')).toEqual([])
      }
    }
  })

  it('a same-turn page refusal posts nothing and an equal shared-params successor reaches the actual tracker', async () => {
    const shared = { same: true }
    for (const mode of ['page', 'reply-meta'] as const) {
      const refusal = new Error('original beforeSend refusal')
      let called = 0
      let original: unknown
      const adapter: MountAdapter = ({ client }) => {
        let result: unknown = null
        return {
          action: () => {
            const rejected = client
              .sendRequest('same', shared, {
                beforeSend: () => {
                  called++
                  throw refusal
                }
              })
              .catch((error) => {
                original = error
              })
            const accepted = client.sendRequest('same', shared).then((reply) => {
              if (!reply.ok) {
                throw new Error(reply.error.message)
              }
              result = reply.result
            })
            return Promise.all([rejected, accepted]).then(() => undefined)
          },
          state: () => ({ result }),
          dispose: () => {}
        }
      }
      const input: RecordingScenario = {
        id: 'zero-post-followed-by-success',
        operation: 'zero-post-contract',
        family: 'zero-post-contract',
        sites: [],
        schedules: [],
        steps: [
          { action: 'start', id: 'start' },
          { complete: 'same#2', params: shared, reply: { ok: true, result: 'fresh' } },
          { checkpoint: 'settled' }
        ]
      }
      const { recording, pairs } = await runInput(input, adapter, mode)
      expect(original).toBe(refusal)
      expect(called).toBe(1)
      expect(senders(recording)[0].bridge!.posts).toEqual([])
      expect(
        senders(recording)[1].bridge!.posts[0].children.map((child) => ({
          name: child.name,
          frame: child.frame?.id
        }))
      ).toEqual([{ name: 'same#2.native-1', frame: 'frame-1' }])
      expect(physical(recording).map((row) => row.name)).toEqual(['same#2.native-1'])
      expect(physical(recording)[0].frame).toEqual({
        id: 'frame-1',
        deviceToken: 'recording-device',
        method: 'same',
        params: shared
      })
      expect(pairs[0].readToShell().filter((frame) => frame.type === 'request')).toHaveLength(1)
      expect(terminal(recording).state).toEqual({ result: 'fresh' })
      expect(terminal(recording).effects).toEqual([])
      expect(terminal(recording).settlements).toMatchObject({ start: { status: 'fulfilled' } })
    }
  })

  it('the real page and host preserve request bytes while first-hop D and final S differ', async () => {
    for (const mode of ['page', 'reply-meta'] as const) {
      const { recording, pairs } = await runInput(base, mount, mode)
      const rows = physical(recording)
      expect(rows.map((row) => row.name)).toEqual([
        'github.listLabels#1.native-1',
        'github.listLabels#1.native-2'
      ])
      expect(rows.map((row) => row.frame)).toEqual([
        { id: 'frame-1', deviceToken: 'recording-device', method: 'status.get' },
        {
          ...options.envelope,
          id: 'frame-2',
          deviceToken: 'recording-device',
          method: 'github.listLabels',
          params
        }
      ])
      expect(rows[1].json).toContain(`"params":${JSON.stringify(params)}`)
      expect(pairs[0].readToShell().filter((frame) => frame.type === 'request')).toEqual([
        expect.objectContaining({ method: 'github.listLabels', params, envelope: options.envelope })
      ])
      expect(senders(recording)[0].bridge!.posts[0].children.map((child) => child.method)).toEqual([
        'status.get',
        'github.listLabels'
      ])
      expect(terminal(recording).state).toEqual({ labels: ['label'] })
      expect(terminal(recording).effects).toEqual([
        { name: 'labels', ordinal: expect.any(Number), value: ['label'] }
      ])
      expect(terminal(recording).settlements).toMatchObject({ start: { status: 'fulfilled' } })
      const replies = pairs[0].readToPage().filter((frame) => frame.type === 'reply')
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ payload: { id: 'frame-2', ok: true, result: ['label'] } })
    }
  })

  it('page replies retain arbitrary user IDs and genuine metadata', async () => {
    const user = {
      id: 'frame-999',
      runtimeId: 'user-runtime',
      sourceId: 'user-source',
      nested: { _meta: { runtimeId: 'keep-nested' }, tag: { $rpc: 'undefined' } }
    }
    const input: RecordingScenario = {
      id: 'real-user-data',
      operation: 'real-user-data',
      family: 'real-user-data',
      sites: [],
      schedules: [],
      steps: [
        { action: 'start', id: 'start' },
        { complete: 'user.read#1', params: {}, reply: { ok: true, result: user } },
        { checkpoint: 'settled' }
      ]
    }
    for (const mode of ['page', 'reply-meta'] as const) {
      let actual: unknown
      const { recording, pairs } = await runInput(
        input,
        ({ client, effect }) => ({
          action: () =>
            client.sendRequest('user.read', {}).then((reply) => {
              if (!reply.ok) {
                throw new Error(reply.error.message)
              }
              actual = reply.result
              effect('user', actual)
            }),
          state: () => actual,
          dispose: () => {}
        }),
        mode
      )
      expect(actual).toEqual(user)
      expect(terminal(recording).state).toEqual(captureValue(user))
      expect(terminal(recording).effects).toEqual([
        { name: 'user', ordinal: expect.any(Number), value: captureValue(user) }
      ])
      const raw = pairs[0].toPage.find((json) => JSON.parse(json).type === 'reply')!
      expect(JSON.parse(raw).payload.result).toEqual(user)
      expect(raw).toContain(JSON.stringify(user))
      expect(JSON.parse(withReplyMeta(raw)).payload.result).toEqual(user)
      expect(physical(recording).map((row) => row.frame)).toEqual([
        { id: 'frame-1', deviceToken: 'recording-device', method: 'user.read', params: {} }
      ])
    }
  })
})
