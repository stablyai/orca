import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '@orca/test-mobile/mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '@orca/test-mobile/transport/rpc-client'
import { isRpcDeliveryUnknown } from '@orca/test-mobile/transport/rpc-delivery-ambiguity'
import { BridgeClientClosedError } from '@orca/test-mobile/mobile-web-shell/bridge/bridge-client-errors'
import { materializeScenario } from '@orca/test-mobile/test-support/rpc-recording/scenario-execution-mode'
import { pilotMountAdapters } from '@orca/test-mobile/test-support/rpc-recording/pilot-mount-adapters'
import { RecordingParamsMismatch } from '@orca/test-mobile/test-support/rpc-recording/recording-mismatch'
import { runRecording } from '@orca/test-mobile/test-support/rpc-recording/run-recording'
import { vitestRecordingScheduler } from '@orca/test-mobile/test-support/rpc-recording/vitest-recording-scheduler'
import type {
  MountedOperation,
  RecordingScenario
} from '@orca/test-mobile/test-support/rpc-recording/recording-scenario'
import { captureValue } from '@orca/test-mobile/test-support/rpc-recording/recording-values'
import { withReplyMeta } from '@orca/test-mobile/test-support/bridged-parity/divergence-evidence'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RPC_METHODS_WITHOUT_SHARED_PARAMS,
  RPC_PARAMS_BY_METHOD
} from '@orca/test-host/shared/rpc-contract/rpc-params-catalog.generated'
import { defineMethod } from '@orca/test-host/main/runtime/rpc/core'
import { parseRpcRequestParams } from '@orca/test-host/main/runtime/rpc/dispatcher-request-parsing'
import { derivedGoldens } from '@orca/test-mobile/test-support/rpc-recording/derived-goldens'
import { readGolden } from '@orca/test-mobile/test-support/rpc-recording/golden-recording'
import { readScenarios } from '@orca/test-mobile/test-support/rpc-recording/scenario-input'

// Parse recorded requests with host schemas; scripted successes can otherwise certify params a real host rejects.

const root = resolve(import.meta.dirname, '../../../..')
const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

// Allow stripped keys only for mixed-version compatibility; fail stale entries so the inventory cannot grow silently.
const STRIPPED_KEY_INVENTORY: readonly InventoryEntry[] = []

type WireRequest = { method: string; params: unknown; golden: string }

function wireRequests(): WireRequest[] {
  const seen = new Map<string, WireRequest>()
  for (const { id } of derivedGoldens(manifest)) {
    for (const checkpoint of readGolden(directory, id).recording.checkpoints) {
      const payloads = checkpoint.observation.payloads
      for (const payload of Array.isArray(payloads) ? payloads : []) {
        const json =
          payload && typeof payload === 'object' && 'json' in payload ? payload.json : undefined
        if (typeof json !== 'string') {
          continue
        }
        const frame: unknown = JSON.parse(json)
        if (!frame || typeof frame !== 'object' || !('method' in frame)) {
          continue
        }
        const method = String(frame.method)
        const params = 'params' in frame ? frame.params : undefined
        const key = `${method}\0${JSON.stringify(params)}`
        if (!seen.has(key)) {
          seen.set(key, { method, params, golden: id })
        }
      }
    }
  }
  return [...seen.values()]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strippedPaths(sent: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(sent) && Array.isArray(parsed)) {
    return sent.flatMap((entry, index) => strippedPaths(entry, parsed[index], `${path}[${index}]`))
  }
  if (!isPlainObject(sent) || !isPlainObject(parsed)) {
    return []
  }
  return Object.keys(sent).flatMap((key) =>
    key in parsed ? strippedPaths(sent[key], parsed[key], `${path}.${key}`) : [`${path}.${key}`]
  )
}

function isEmptyParams(params: unknown): boolean {
  return (
    params === undefined ||
    params === null ||
    (isPlainObject(params) && !Object.keys(params).length)
  )
}

type InventoryEntry = { method: string; path: string; reason: string }

function contractProblems(
  requests: readonly WireRequest[],
  inventory: readonly InventoryEntry[]
): string[] {
  const unshared = new Set(RPC_METHODS_WITHOUT_SHARED_PARAMS)
  const problems: string[] = []
  const stripped = new Set<string>()
  for (const { method, params, golden } of requests) {
    const where = `${golden}: ${method} ${JSON.stringify(params)}`
    if (unshared.has(method)) {
      continue
    }
    if (!(method in RPC_PARAMS_BY_METHOD)) {
      problems.push(`${where}\n    the host has no method ${method}`)
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `method in RPC_PARAMS_BY_METHOD` was checked just above.
    const schema = RPC_PARAMS_BY_METHOD[method as keyof typeof RPC_PARAMS_BY_METHOD]
    if (schema === null) {
      // The dispatcher never reads params for these, so anything sent is dropped whole.
      if (!isEmptyParams(params)) {
        problems.push(`${where}\n    ${method} takes no params; the host ignores these`)
      }
      continue
    }
    const parsed = parseRpcRequestParams(
      { id: 'recorded', authToken: 'recorded', method, params },
      defineMethod({ name: method, params: schema, handler: () => null }),
      { runtimeId: 'recorded' }
    )
    if (parsed.error) {
      const refusal = parsed.error.ok ? '' : parsed.error.error.message
      problems.push(`${where}\n    the host refuses it: ${refusal}`)
      continue
    }
    for (const path of strippedPaths(params, parsed.value)) {
      if (inventory.some((entry) => entry.method === method && entry.path === path)) {
        stripped.add(`${method}\0${path}`)
      } else {
        problems.push(`${where}\n    the host drops ${path}`)
      }
    }
  }
  const stale = inventory
    .filter((entry) => !stripped.has(`${entry.method}\0${entry.path}`))
    .map((entry) => `${entry.method} ${entry.path}: no recorded request sends it any more`)
  return [...problems, ...stale]
}

describe('recorded requests against the host params contract', () => {
  it('sends only methods and params the host dispatcher accepts', () => {
    const requests = wireRequests()
    expect(requests.length).toBeGreaterThan(0)
    expect(contractProblems(requests, STRIPPED_KEY_INVENTORY)).toEqual([])
    // Resolving the full golden corpus can exceed the default timeout on loaded CI workers.
  }, 60_000)

  it('smart-search distinguishes an own undefined workspaceId from an absent wire key and stops before the unentered action', async () => {
    const original: RecordingScenario = {
      id: 'smart-search-own-undefined',
      operation: 'tasks.smart-source-search',
      family: 'tasks.smart-source-search',
      sites: [],
      schedules: [],
      steps: [
        { checkpoint: 'before' },
        { action: 'linear', id: 'linear-assigned', args: { query: '  ', workspace: null } },
        { checkpoint: 'pending' },
        {
          bind: 'assigned',
          request: 'linear.listIssues#1.native-1',
          params: { filter: 'assigned', limit: 50 },
          transport: 'bridge'
        },
        {
          complete: 'assigned',
          params: { filter: 'assigned', limit: 50, workspaceId: undefined },
          reply: { ok: true, result: [] },
          site: 'linear-assigned',
          transport: 'bridge'
        },
        { action: 'unentered', id: 'unentered' },
        { checkpoint: 'unentered' }
      ]
    }
    for (const rewriteToPage of [undefined, withReplyMeta]) {
      const pairs: BridgePortPair<RpcClient>[] = []
      const actions: string[] = []
      const states: unknown[] = []
      const actionPhases: string[] = []
      const observed: {
        mounted?: MountedOperation
        action?: Promise<unknown>
        outcome?: { value: unknown } | { error: unknown }
      } = {}
      const mounted = pilotMountAdapters(root).adapters[original.operation]!
      let failure: { error: unknown } | undefined
      try {
        await runRecording(
          materializeScenario(original, 'bridge'),
          (context) => {
            const actual = mounted(context)
            observed.mounted = actual
            return {
              ...actual,
              action(...args) {
                actions.push(args[0])
                const result = actual.action(...args)
                if (!(result instanceof Promise)) {
                  throw new Error('Missing original search action promise')
                }
                observed.action = result
                void result.then(
                  (value: unknown) => {
                    observed.outcome = { value }
                  },
                  (error: unknown) => {
                    observed.outcome = { error }
                  }
                )
                return result
              },
              state() {
                const state = actual.state()
                states.push(captureValue(state))
                actionPhases.push(
                  observed.action === undefined
                    ? 'not-started'
                    : observed.outcome === undefined
                      ? 'pending'
                      : 'settled'
                )
                return state
              }
            }
          },
          vitestRecordingScheduler(),
          (rpc, observation) => {
            const pair = createBridgePortPair({
              rpc,
              observation: observation.openBridge(),
              rewriteToPage
            })
            observation.onDispose(() => disposeBridgePortPair(pair))
            pairs.push(pair)
            for (let turn = 0; turn < 4; turn += 1) {
              pair.drainNow()
            }
            return pair.client
          }
        )
      } catch (error) {
        failure = { error }
      }
      expect(failure?.error).toBeInstanceOf(RecordingParamsMismatch)
      if (!(failure?.error instanceof RecordingParamsMismatch)) {
        throw new Error('Missing actual strict params guard')
      }
      expect(failure.error.request).toBe('linear.listIssues#1.native-1')
      expect(failure.error.actual).toEqual({ filter: 'assigned', limit: 50 })
      if (
        failure.error.actual === null ||
        typeof failure.error.actual !== 'object' ||
        failure.error.expected === null ||
        typeof failure.error.expected !== 'object'
      ) {
        throw new Error('Missing actual params objects')
      }
      expect(Object.hasOwn(failure.error.actual, 'workspaceId')).toBe(false)
      expect(failure.error.expected).toEqual({
        filter: 'assigned',
        limit: 50,
        workspaceId: undefined
      })
      expect(Object.hasOwn(failure.error.expected, 'workspaceId')).toBe(true)
      expect(actions).toEqual(['linear'])
      expect(states).toEqual([{}, {}])
      expect(actionPhases).toEqual(['not-started', 'pending'])
      if (!observed.action || !observed.mounted) {
        throw new Error('Missing original mounted search action')
      }
      await expect(observed.action).rejects.toBeInstanceOf(BridgeClientClosedError)
      if (!observed.outcome || !('error' in observed.outcome)) {
        throw new Error('Original search action did not reject during ordinary cleanup')
      }
      expect(observed.outcome.error).toMatchObject({ message: 'the page bridge was closed' })
      expect(isRpcDeliveryUnknown(observed.outcome.error)).toBe(true)
      const finalState = observed.mounted.state()
      expect(finalState).toEqual({})
      if (finalState === null || typeof finalState !== 'object') {
        throw new Error('Missing final search results')
      }
      expect(Object.hasOwn(finalState, 'linear')).toBe(false)
      expect(pairs).toHaveLength(1)
      const posted = pairs[0]!.readToShell().filter((frame) => frame.type === 'request')
      expect(posted).toMatchObject([
        { method: 'linear.listIssues', params: { filter: 'assigned', limit: 50 } }
      ])
      expect(posted).toHaveLength(1)
      expect(
        pairs[0]!.toPage.map((json) => JSON.parse(json)).filter((frame) => frame.type === 'reply')
      ).toEqual([])
    }
    const native = await runRecording(
      {
        ...original,
        steps: [
          { action: 'linear', id: 'linear-assigned', args: { query: '  ', workspace: null } },
          {
            complete: 'linear.listIssues#1',
            params: { filter: 'assigned', limit: 50, workspaceId: undefined },
            reply: { ok: true, result: [] }
          },
          { checkpoint: 'success' }
        ]
      },
      pilotMountAdapters(root).adapters[original.operation]!,
      vitestRecordingScheduler()
    )
    expect(native.checkpoints[0]!.observation.settlements).toMatchObject({
      'linear-assigned': { status: 'fulfilled', value: [] }
    })
  })
})
