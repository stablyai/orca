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
} {
  let calls = 0
  const client: UnvalidatedRpcRequestPort = {
    sendRequest: () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!
      calls += 1
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    }
  }
  return { client, calls: () => calls }
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
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers the parsed status once and stops', async () => {
    const { client, calls } = makeClient([
      ok({ machineName: 'm4airs-Air', hostPlatform: 'darwin', capabilities: ['a.v1'] })
    ])
    const seen: (HostStatusReply | null)[] = []
    const cancel = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ machineName: 'm4airs-Air', hostPlatform: 'darwin' })
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(1)
    cancel()
  })

  it('delivers null for an answer this build cannot decode, without retrying', async () => {
    const { client, calls } = makeClient([ok(null)])
    const seen: (HostStatusReply | null)[] = []
    const cancel = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toEqual([null])
    expect(calls()).toBe(1)
    cancel()
  })

  it('retries a refusal and a cutover rejection until a status lands', async () => {
    const refusal: RpcResponse = {
      ok: false,
      id: '1',
      error: { code: 'unavailable', message: 'no' },
      _meta: { runtimeId: 'r1' }
    }
    const { client, calls } = makeClient([
      refusal,
      new LogicalClientCutoverError(),
      ok({ machineName: 'Studio' })
    ])
    const seen: (HostStatusReply | null)[] = []
    const cancel = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ machineName: 'Studio' })
    expect(calls()).toBe(3)
    cancel()
  })

  it('reports each failed attempt once its retry is scheduled, and never an answer', async () => {
    const { client } = makeClient([
      new Error('request timed out'),
      new LogicalClientCutoverError(),
      ok(null)
    ])
    const seen: (HostStatusReply | null)[] = []
    let failed = 0
    const cancel = startRuntimeStatusProbe(
      client,
      (status) => seen.push(status),
      () => {
        failed += 1
      }
    )
    await flushMicrotasks()
    expect(failed).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(failed).toBe(2)
    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
    expect(seen).toEqual([null])
    expect(failed).toBe(2)
    cancel()
  })
})
