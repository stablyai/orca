import { describe, expect, it } from 'vitest'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair,
  type BridgePortPairOptions
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../../mobile-web-shell/bridge/bridge-caps'
import type { RpcClient } from '../../transport/rpc-client'
import type {
  MountAdapter,
  Recording,
  RecordingScenario
} from '../rpc-recording/recording-scenario'
import { materializeScenario } from '../rpc-recording/scenario-execution-mode'
import { captureValue } from '../rpc-recording/recording-values'
import { runRecording } from '../rpc-recording/run-recording'
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
const _mount: MountAdapter = ({ client, effect }) => {
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
async function runBridge(
  scenario: RecordingScenario,
  adapter: MountAdapter,
  rewriteToPage?: (json: string) => string,
  device: Pick<BridgePortPairOptions<RpcClient>, 'serveNativeVerb' | 'routeGrants'> = {}
) {
  const pairs: BridgePortPair<RpcClient>[] = []
  const recording = await runRecording(
    materializeScenario(scenario, 'bridge'),
    adapter,
    vitestRecordingScheduler(),
    (rpc, observation) => {
      const pair = createBridgePortPair({
        rpc,
        observation: observation.openBridge(),
        rewriteToPage,
        ...device
      })
      pairs.push(pair)
      observation.onDispose(() => disposeBridgePortPair(pair))
      for (let turn = 0; turn < 4; turn++) {
        pair.drainNow()
      }
      return pair.client
    }
  )
  return { recording, pair: pairs[0] }
}
function terminal(recording: Recording) {
  return recording.checkpoints.at(-1)!.observation
}

describe('actual publication and device replies', () => {
  it('real subscribe publication keeps its order relative to a request and a product effect', async () => {
    const adapter: MountAdapter = ({ client, effect }) => {
      let release: (() => void) | undefined
      let labels: unknown = null
      return {
        action: () => {
          release = client.subscribe('runtime.clientEvents.subscribe', null, () => {})
          effect('after-original-subscribe', { returned: typeof release === 'function' })
          return client.sendRequest('github.listLabels', params, options).then((reply) => {
            if (!reply.ok) {
              throw new Error(reply.error.message)
            }
            labels = reply.result
          })
        },
        state: () => ({ labels }),
        dispose: () => release?.()
      }
    }
    const input: RecordingScenario = {
      ...base,
      id: 'initial-before-unary',
      operation: 'initial-publication-contract',
      family: 'initial-publication-contract'
    }
    const native = await runRecording(
      materializeScenario(input, 'native'),
      adapter,
      vitestRecordingScheduler()
    )
    for (const rewrite of [undefined, withReplyMeta]) {
      const { recording, pair } = await runBridge(input, adapter, rewrite)
      const sent = pair
        .readToShell()
        .filter(
          (frame) =>
            frame.type === 'subscribe' ||
            frame.type === 'request' ||
            (frame.type === 'cancel' && frame.target === 'subscription')
        )
      expect(sent.map((frame) => frame.type)).toEqual(['subscribe', 'request', 'cancel'])
      expect(sent[0]).toMatchObject({ method: 'runtime.clientEvents.subscribe', params: null })
      const opening = sent[0]
      if (opening?.type !== 'subscribe') {
        throw new Error('Missing original subscription opening')
      }
      expect(sent[2]).toMatchObject({ id: opening.id })
      const last = terminal(recording)
      expect(last.state).toEqual({ labels: ['label'] })
      expect(last.effects).toEqual([
        {
          name: 'after-original-subscribe',
          ordinal: expect.any(Number),
          value: { returned: true }
        },
        {
          name: 'streams-registered-at-teardown',
          ordinal: expect.any(Number),
          value: [
            {
              method: 'runtime.clientEvents.subscribe',
              payload: 'runtime.clientEvents.subscribe#1',
              cancelled: true
            }
          ]
        }
      ])
      if (!Array.isArray(last.payloads) || !Array.isArray(last.effects)) {
        throw new Error('Missing actual publication bytes/effect')
      }
      const frames = last.payloads.map((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          typeof row.json !== 'string' ||
          typeof row.ordinal !== 'number'
        ) {
          throw new Error('Missing frame')
        }
        return { frame: JSON.parse(row.json), ordinal: row.ordinal }
      })
      expect(frames.map((row) => row.frame.method)).toEqual([
        'runtime.clientEvents.subscribe',
        'status.get',
        'github.listLabels'
      ])
      expect(frames[0].frame.params).toBeNull()
      expect(frames[2].frame).toMatchObject({ ...options.envelope, params })
      const effect = last.effects[0]
      if (
        !effect ||
        typeof effect !== 'object' ||
        Array.isArray(effect) ||
        typeof effect.ordinal !== 'number'
      ) {
        throw new Error('Missing original effect')
      }
      expect(effect.ordinal).toBeLessThan(frames[0].ordinal)
      expect(frames[0].ordinal).toBeLessThan(frames[1].ordinal)
      expect(frames[1].ordinal).toBeLessThan(frames[2].ordinal)
      expect(last.settlements).toMatchObject({ start: { status: 'fulfilled' } })
    }
    const original = terminal(native)
    expect(original.state).toEqual({ labels: ['label'] })
    if (!Array.isArray(original.payloads) || !Array.isArray(original.effects)) {
      throw new Error('Missing native work')
    }
    expect(
      original.payloads.map(
        (row) =>
          JSON.parse(String(row && typeof row === 'object' && !Array.isArray(row) && row.json))
            .method
      )
    ).toEqual(['runtime.clientEvents.subscribe', 'github.listLabels'])
    expect(original.effects).toEqual([
      { name: 'after-original-subscribe', ordinal: expect.any(Number), value: { returned: true } },
      {
        name: 'streams-registered-at-teardown',
        ordinal: expect.any(Number),
        value: [
          {
            method: 'runtime.clientEvents.subscribe',
            payload: 'runtime.clientEvents.subscribe#1',
            cancelled: true
          }
        ]
      }
    ])
  })

  it.each(['chunked', 'params-refused', 'handler-rejected', 'result-refused'] as const)(
    'real device clipboard replies preserve results and refusals through the page (%s)',
    async (variant) => {
      const requestParams =
        variant === 'params-refused' ? { mime: 'ungranted-mime' } : { mime: 'text' }
      const value = 'device text '.repeat(65_000)
      expect(
        utf8ByteLength(JSON.stringify({ id: 'device-reply', ok: true, result: { value } }))
      ).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES)
      expect(
        utf8ByteLength(JSON.stringify({ id: 'device-reply', ok: true, result: { value } }))
      ).toBeLessThan(BRIDGE_MAX_REPLY_BYTES)
      const scenario: RecordingScenario = {
        id: `native-device-${variant}`,
        operation: 'native-device-contract',
        family: 'native-device-contract',
        sites: [],
        schedules: [],
        lineage: {
          baseScenario: 'native-device-contract',
          mode: 'bridge',
          domain: 'bridge-only',
          partition: variant
        },
        steps: [{ action: 'read', id: 'read' }, { checkpoint: 'answered' }]
      }
      let served = 0
      const device = {
        routeGrants: ['native.clipboard.read'],
        serveNativeVerb: async () => {
          served++
          if (variant === 'handler-rejected') {
            throw new Error('private original handler failure')
          }
          return variant === 'result-refused' ? { undeclared: true } : { value }
        }
      }
      const adapter: MountAdapter = ({ client }) => {
        let answer: unknown = null
        return {
          action: () =>
            client.sendRequest('native.clipboard.read', requestParams).then((reply) => {
              answer = reply
            }),
          state: () => ({ answer }),
          dispose: () => {}
        }
      }
      for (const rewrite of [undefined, withReplyMeta]) {
        const before = served
        const { recording, pair } = await runBridge(scenario, adapter, rewrite, device)
        expect(served - before).toBe(variant === 'params-refused' ? 0 : 1)
        expect(terminal(recording).payloads).toEqual([])
        expect(terminal(recording).effects).toEqual([])
        expect(pair.readToShell().filter((frame) => frame.type === 'request')).toEqual([
          expect.objectContaining({ method: 'native.clipboard.read', params: requestParams })
        ])
        if (variant === 'chunked') {
          const parts = pair
            .readToPage()
            .filter((frame) => frame.type === 'reply' && 'part' in frame)
          expect(parts.length).toBeGreaterThan(1)
          expect(parts.map((frame) => 'part' in frame && frame.part)).toEqual(
            parts.map((_, i) => ({ i, of: parts.length }))
          )
          const assembled = JSON.parse(
            parts.map((frame) => ('chunk' in frame ? frame.chunk : '')).join('')
          )
          expect(assembled).toEqual({ id: expect.any(String), ok: true, result: { value } })
          expect(terminal(recording).state).toEqual(captureValue({ answer: assembled }))
          expect(terminal(recording).settlements).toMatchObject({ read: { status: 'fulfilled' } })
          expect(
            pair.toPage.every((json) => utf8ByteLength(json) <= BRIDGE_MAX_MESSAGE_BYTES)
          ).toBe(true)
        } else {
          const code =
            variant === 'params-refused'
              ? 'native_verb_params'
              : variant === 'handler-rejected'
                ? 'native_verb_failed'
                : 'native_verb_result'
          expect(pair.readToPage().filter((frame) => frame.type === 'error')).toEqual([
            expect.objectContaining({ error: expect.objectContaining({ code }) })
          ])
          expect(terminal(recording).state).toEqual(captureValue({ answer: null }))
          expect(terminal(recording).settlements).toMatchObject({
            read: { status: 'rejected', error: expect.objectContaining({ code }) }
          })
        }
      }
      if (variant === 'chunked') {
        const broken = await runBridge(
          scenario,
          adapter,
          (json) => {
            const frame = JSON.parse(json)
            return frame.type === 'reply' && frame.part?.i === 0
              ? JSON.stringify({ ...frame, chunk: frame.chunk.slice(1) })
              : json
          },
          device
        )
        expect(terminal(broken.recording).state).toEqual(captureValue({ answer: null }))
        expect(terminal(broken.recording).settlements).toMatchObject({
          read: { status: 'rejected' }
        })
        expect(terminal(broken.recording).settlements).toMatchObject({
          read: {
            status: 'rejected',
            error: {
              category: 'BridgeReplyRefusedError',
              message: 'the reply could not be read (malformed-json)'
            }
          }
        })
      }
    }
  )
})
