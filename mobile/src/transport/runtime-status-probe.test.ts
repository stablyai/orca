import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntimeStatusProbe } from './runtime-status-probe'
import { LogicalClientCutoverError } from './stable-logical-rpc-client'
import type { HostStatusReply } from './host-status-reply-schema'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import type { RpcResponse } from './types'

type ProbeOutcome = RpcResponse | Error

function makeClient(outcomes: ProbeOutcome[]): {
  client: UnvalidatedRpcRequestPort
  calls: () => number
  requests: () => Parameters<UnvalidatedRpcRequestPort['sendRequest']>[]
} {
  let calls = 0
  const client = {
    sendRequest: vi.fn<UnvalidatedRpcRequestPort['sendRequest']>(() => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!
      calls += 1
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    })
  }
  return { client, calls: () => calls, requests: () => client.sendRequest.mock.calls }
}

const ok = (result: unknown): RpcResponse => ({
  ok: true,
  id: '1',
  result,
  _meta: { runtimeId: 'r1' }
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('startRuntimeStatusProbe', () => {
  let cancelProbe: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cancelProbe?.()
    cancelProbe = undefined
    vi.useRealTimers()
  })

  it('delivers the parsed status once and stops', async () => {
    const { client, calls, requests } = makeClient([
      ok({ machineName: 'm4airs-Air', hostPlatform: 'darwin', capabilities: ['a.v1'] })
    ])
    const seen: (HostStatusReply | null)[] = []
    cancelProbe = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      machineName: 'm4airs-Air',
      hostPlatform: 'darwin',
      capabilities: ['a.v1']
    })
    expect(requests()).toEqual([['status.get']])
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(1)
    cancelProbe()
  })

  it('delivers null for an answer this build cannot decode, without retrying', async () => {
    const { client, calls, requests } = makeClient([ok(null)])
    const seen: (HostStatusReply | null)[] = []
    const failed = vi.fn()
    cancelProbe = startRuntimeStatusProbe(client, (status) => seen.push(status), failed)
    await flushMicrotasks()
    expect(seen).toEqual([null])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual([null])
    expect(failed).not.toHaveBeenCalled()
    expect(requests()).toEqual([['status.get']])
    expect(vi.getTimerCount()).toBe(0)
    expect(calls()).toBe(1)
    cancelProbe()
  })

  it('retries a refusal and a cutover rejection until a status lands', async () => {
    const refusal: RpcResponse = {
      ok: false,
      id: '1',
      error: { code: 'unavailable', message: 'no' },
      _meta: { runtimeId: 'r1' }
    }
    const { client, calls, requests } = makeClient([
      refusal,
      new LogicalClientCutoverError(),
      ok({ machineName: 'Studio' })
    ])
    const seen: (HostStatusReply | null)[] = []
    cancelProbe = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toEqual([])
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(calls()).toBe(2)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(249)
    expect(calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ machineName: 'Studio' })
    expect(calls()).toBe(3)
    expect(requests()).toEqual([['status.get'], ['status.get'], ['status.get']])
    expect(vi.getTimerCount()).toBe(0)
    cancelProbe()
  })

  it('reports failed attempts after scheduling retries and cancels pending work', async () => {
    const { client, calls, requests } = makeClient([
      new Error('request timed out'),
      new LogicalClientCutoverError()
    ])
    const seen: (HostStatusReply | null)[] = []
    let failed = 0
    const failedTimerCounts: number[] = []
    cancelProbe = startRuntimeStatusProbe(
      client,
      (status) => seen.push(status),
      () => {
        failed += 1
        failedTimerCounts.push(vi.getTimerCount())
      }
    )
    await flushMicrotasks()
    expect(failed).toBe(1)
    expect(failedTimerCounts).toEqual([1])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(failed).toBe(2)
    expect(failedTimerCounts).toEqual([1, 1])
    expect(vi.getTimerCount()).toBe(1)
    cancelProbe()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual([])
    expect(failed).toBe(2)
    expect(failedTimerCounts).toEqual([1, 1])
    expect(calls()).toBe(2)
    expect(requests()).toEqual([['status.get'], ['status.get']])
  })
})
