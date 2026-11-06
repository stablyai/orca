import type * as GithubPrRpcModule from '../../session/github-pr-rpc'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import { withReplyMeta } from '../bridged-parity/divergence-evidence'

import { resolve } from 'node:path'
import { operationModuleLoader } from './operation-module-loader'
import { describe, expect, it, vi } from 'vitest'

import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { goldenBytes, goldenRecording } from './golden-recording'

import { runRecording } from './run-recording'

import type { RecordingScenario } from './recording-scenario'

describe('recording boundaries', () => {
  it('requires logical bindings plus matching params for concurrent same-method calls', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    try {
      const left = transport.client.sendRequest('files.list', { worktree: 'A' })
      const right = transport.client.sendRequest('files.list', { worktree: 'B' })
      await clock.flush()
      expect(() => transport.complete('files.list#1', { worktree: 'A' }, {})).toThrow(
        'logical binding'
      )
      expect(() => transport.bind('left', 'files.list#1', { worktree: 'B' })).toThrow(
        'params mismatch'
      )
      transport.bind('left', 'files.list#1', { worktree: 'A' })
      transport.bind('right', 'files.list#2', { worktree: 'B' })
      transport.complete('right', { worktree: 'B' }, { ok: true, result: [] })
      transport.complete('left', { worktree: 'A' }, { ok: true, result: [] })
      await Promise.all([left, right])
    } finally {
      await transport.dispose()
      await clock.flush()
      transport.causality.assertTransparentCalls()
      transport.causality.close()
      clock.stop()
    }
  })

  it('records actual deadline ambiguity and leaves peers pending before their deadlines', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    try {
      void transport.client.sendRequest('short', {}, { timeoutMs: 5 }).catch(() => {})
      void transport.client.sendRequest('long', {}, { timeoutMs: 50 }).catch(() => {})
      await clock.advance(5)
      expect(transport.requests[0].settlement).toEqual({
        status: 'rejected',
        startedAt: 0,
        settledAt: 5,
        error: {
          category: 'Error',
          message: 'Request timed out: short',
          isRpcDeliveryUnknown: true
        }
      })
      expect(transport.requests[1].settlement).toEqual({ status: 'pending', startedAt: 0 })
    } finally {
      await transport.dispose()
      await clock.flush()
      transport.causality.assertTransparentCalls()
      transport.causality.close()
      clock.stop()
    }
  })
})

describe('actual invocation ownership and fatal output boundaries', () => {
  it('binds equal same-turn refused and successful requests to their actual physical frames in native and page modes', async () => {
    for (const mode of ['native', 'page-original', 'page-reply-meta'] as const) {
      const clock = vitestRecordingScheduler()
      await clock.start()
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      let hold = true
      let pair: BridgePortPair<RpcClient> | undefined
      const transport = new ScriptedRpcTransport(
        clock.elapsed,
        undefined,
        mode === 'native'
          ? undefined
          : (rpc, observation) => {
              pair = createBridgePortPair({
                rpc,
                observation: observation.openBridge(),
                rewriteToPage: mode === 'page-reply-meta' ? withReplyMeta : undefined
              })
              observation.onDispose(() => disposeBridgePortPair(pair!))
              for (let round = 0; round < 4; round++) {
                pair.drainNow()
              }
              return pair.client
            },
        undefined,
        () => (hold ? wait : Promise.resolve())
      )
      const shared = { same: true }
      const sentinel = new Error('original admission refusal')
      let callbacks = 0
      const originalOptions = {
        beforeSend: function (this: unknown) {
          expect(this).toBe(originalOptions)
          callbacks++
          throw sentinel
        }
      }
      try {
        const refused = (async () =>
          transport.client.sendRequest('same', shared, originalOptions))().catch((error) => error)
        const accepted = transport.client.sendRequest('same', shared)
        await clock.flush()
        expect(transport.payloads).toEqual([])
        expect(transport.pendingRequests()).toBe(0)
        release()
        hold = false
        await clock.flush()
        expect(await refused).toBe(sentinel)
        expect(callbacks).toBe(1)
        const child = mode === 'native' ? 'same#2' : 'same#2.native-1'
        expect(transport.payloads).toEqual([
          {
            name: child,
            ordinal: expect.any(Number),
            json: JSON.stringify({
              id: 'frame-1',
              deviceToken: 'recording-device',
              method: 'same',
              params: shared
            })
          }
        ])
        transport.complete(child, shared, { ok: true, result: 'successor' })
        await clock.flush()
        await expect(accepted).resolves.toMatchObject({ result: 'successor' })
        expect(transport.pendingRequests()).toBe(0)
        const a = transport.client.sendRequest('same', shared)
        const b = transport.client.sendRequest('same', shared)
        const c = transport.client.sendRequest('other', shared)
        await clock.flush()
        const suffix = mode === 'native' ? '' : '.native-1'
        transport.bind('A', `same#3${suffix}`, shared)
        transport.bind('B', `same#4${suffix}`, shared)
        transport.complete(`other#1${suffix}`, shared, { ok: true, result: 'C' })
        transport.complete('B', shared, { ok: true, result: 'B' })
        transport.complete('A', shared, { ok: true, result: 'A' })
        await clock.flush()
        await expect(Promise.all([a, b, c])).resolves.toMatchObject([
          { result: 'A' },
          { result: 'B' },
          { result: 'C' }
        ])
        expect(transport.payloads.map((row) => row.name)).toEqual([
          child,
          `same#3${suffix}`,
          `same#4${suffix}`,
          `other#1${suffix}`
        ])
        await expect(
          (async () => transport.client.sendRequest('same', shared, originalOptions))()
        ).rejects.toBe(sentinel)
        const fresh = transport.client.sendRequest('same', shared)
        await clock.flush()
        transport.complete(`same#6${suffix}`, shared, { ok: true, result: 'fresh' })
        await clock.flush()
        await expect(fresh).resolves.toMatchObject({ result: 'fresh' })
        transport.disconnect()
        const disconnected = transport.client.sendRequest('same', shared).catch((error) => error)
        await clock.flush()
        expect(await disconnected).toBeInstanceOf(Error)
        transport.state = 'connected'
        await transport.cutover()
        const continued = transport.client.sendRequest('same', shared)
        await clock.flush()
        transport.complete(`same#8${suffix}`, shared, { ok: true, result: 'continued' })
        await clock.flush()
        await expect(continued).resolves.toMatchObject({ result: 'continued' })
        expect(transport.pendingRequests()).toBe(0)
        expect(clock.timerEvidence!().residual).toBe(0)
        transport.causality.assertTransparentCalls()
        if (mode !== 'native') {
          expect(pair!.readToShell().filter((frame) => frame.type === 'request')).toHaveLength(7)
        }
      } finally {
        await transport.dispose()
        await clock.flush()
        transport.causality.close()
        clock.stop()
      }
    }
    for (const kind of ['duplicate', 'invented'] as const) {
      const clock = vitestRecordingScheduler()
      await clock.start()
      let invented: (() => unknown) | undefined
      const transport = new ScriptedRpcTransport(clock.elapsed, undefined, (client) => {
        invented = () => client.sendRequest('same', {})
        return kind === 'invented'
          ? client
          : {
              ...client,
              sendRequest: (...args) => {
                const original = client.sendRequest(...args)
                void original.catch(() => {})
                return client.sendRequest(...args)
              }
            }
      })
      try {
        if (kind === 'invented') {
          expect(() => invented!()).toThrow('no causal parent')
          expect(transport.requests).toEqual([])
          expect(transport.payloads).toEqual([])
        } else {
          expect(() => transport.client.sendRequest('same', {})).toThrow(
            'added a native invocation'
          )
          await clock.flush()
          expect(transport.payloads.map((row) => row.name)).toEqual(['same#1'])
          transport.complete('same#1', {}, { ok: true, result: 'original still made' })
          await clock.flush()
        }
        expect(() => transport.check()).toThrow(
          kind === 'invented' ? 'no causal parent' : 'added a native invocation'
        )
      } finally {
        await transport.dispose()
        await clock.flush()
        transport.causality.close()
        clock.stop()
      }
    }
  })

  it('a caught fixture capture fault and a cleanup failure cannot return or write a product recording', async () => {
    const root = resolve(import.meta.dirname, '../../../..')
    for (const origin of ['arguments', 'settlement', 'effect'] as const) {
      const loader = operationModuleLoader(
        root,
        origin === 'arguments'
          ? {
              name: 'unsupported-original-request-value',
              file: 'session/github-pr-rpc.ts',
              before:
                'githubPrRequestParams(githubPrRepoSlugRead.operation.method, worktreeId, {})',
              after:
                'githubPrRequestParams(githubPrRepoSlugRead.operation.method, worktreeId, { arbitrary: () => {} })'
            }
          : undefined
      )
      const reads = loader.load<typeof GithubPrRpcModule>('mobile/src/session/github-pr-rpc.ts')
      const steps: RecordingScenario['steps'] = [{ action: 'read', id: 'read' }]
      if (origin !== 'arguments') {
        steps.push({
          complete: 'github.repoSlug#1',
          params: { repo: 'id:repo-9' },
          reply: { ok: true, result: origin === 'settlement' ? { arbitrary: () => {} } : null }
        })
      }
      steps.push({ checkpoint: 'settled' })
      const scenario: RecordingScenario = {
        id: `caught-${origin}`,
        operation: 'session.pr-reads',
        family: 'session.pr-reads',
        sites: [],
        schedules: [],
        steps
      }
      const cleanup = new Error('independent acquired cleanup')
      const calls: string[] = []
      const scheduler = vitestRecordingScheduler()
      const construct = vi.fn(goldenRecording)
      const writer = vi.fn()
      let failure: { error: unknown } | undefined
      try {
        const recording = await runRecording(
          scenario,
          ({ client, effect }) => ({
            action: async () => {
              const result = await reads.fetchGithubRepoSlug(client, 'repo-9::/w')
              if (origin === 'effect') {
                try {
                  effect('actual-repo-result', {
                    result,
                    unsupported: new Date('2026-01-01T00:00:00Z')
                  })
                } catch {}
              }
              return result
            },
            state: () => ({}),
            dispose: () => {
              calls.push('mounted')
              throw cleanup
            }
          }),
          {
            ...scheduler,
            stop: () => {
              calls.push('clock')
              scheduler.stop()
            }
          },
          (client, observation) => {
            observation.onDispose(() => {
              calls.push('wrapper')
            })
            return client
          }
        )
        writer(goldenBytes(construct([scenario], recording)))
      } catch (error) {
        failure = { error }
      }
      expect(failure).toBeDefined()
      expect(failure!.error).toBeInstanceOf(AggregateError)
      const error = failure!.error
      if (!(error instanceof AggregateError)) {
        throw new Error('Missing actual capture/cleanup failures')
      }
      expect(error.errors[0]).toBeInstanceOf(Error)
      expect(String(error.errors[0])).toMatch(/Unsupported observation|explicit projection/)
      expect(error.errors).toContain(cleanup)
      expect(calls).toEqual(['mounted', 'wrapper', 'clock'])
      expect(construct).not.toHaveBeenCalled()
      expect(writer).not.toHaveBeenCalled()
      if (origin === 'arguments') {
        expect(loader.mutationsApplied()).toBe(1)
      }
    }
    const scenario: RecordingScenario = {
      id: 'raw-roles',
      operation: 'raw-roles',
      family: 'raw-roles',
      sites: [],
      schedules: [],
      steps: [{ checkpoint: 'never' }]
    }
    for (const raw of [undefined, null, new Error('reused raw object')]) {
      let result: { error: unknown } | undefined
      try {
        await runRecording(
          scenario,
          ({ captureObservation }) => {
            captureObservation!('original mount', () => {
              throw raw
            })
            throw new Error('unreachable original mount')
          },
          vitestRecordingScheduler()
        )
      } catch (error) {
        result = { error }
      }
      expect(result?.error).toBeInstanceOf(AggregateError)
      if (!(result?.error instanceof AggregateError)) {
        throw new Error('Missing two observed roles')
      }
      expect(result.error.errors).toHaveLength(2)
      expect(result.error.errors[0]).toBe(raw)
      expect(result.error.errors[1]).toBe(raw)
      result = undefined
      try {
        await runRecording(
          scenario,
          () => {
            throw raw
          },
          vitestRecordingScheduler()
        )
      } catch (error) {
        result = { error }
      }
      expect(result).toEqual({ error: raw })
    }
  })
})
