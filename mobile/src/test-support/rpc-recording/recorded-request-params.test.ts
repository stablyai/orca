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

// Parse recorded requests with host schemas; scripted successes can otherwise certify params a real host rejects.

const root = resolve(import.meta.dirname, '../../../..')

describe('recorded requests against the host params contract', () => {
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
      // Ordinary cleanup closes the native connection first, so the page caller gets its relayed rejection.
      await expect(observed.action).rejects.toMatchObject({ message: 'Connection closed' })
      if (!observed.outcome || !('error' in observed.outcome)) {
        throw new Error('Original search action did not reject during ordinary cleanup')
      }
      expect(observed.outcome.error).not.toBeInstanceOf(BridgeClientClosedError)
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
            params: { filter: 'assigned', limit: 50 },
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
