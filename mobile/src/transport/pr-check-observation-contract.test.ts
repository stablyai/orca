import { expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { recordRuntimeStatusProbe } from './runtime-status-probe'
import { captureMobilePRCheckContract } from './pr-check-observation-contract'
import {
  GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as complete,
  GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as exact
} from '../../../src/shared/source-control/runtime/source-control-runtime-capabilities'

function host(capabilities: string[]) {
  let generation = 1
  let state: ReturnType<RpcClient['getState']> = 'connected'
  const listeners = new Set<Parameters<RpcClient['onStateChange']>[0]>()
  const sendRequest = vi.fn(async () => ({
    id: 'status',
    ok: true as const,
    result: { runtimeId: 'runtime-1', hostDescriptor: { installationId: 'host-1' }, capabilities }
  }))
  const client = {
    sendRequest,
    getGeneration: () => generation,
    getState: () => state,
    getLastConnectedAt: () => generation,
    onStateChange: (listener: Parameters<RpcClient['onStateChange']>[0]) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    carriesRpcEnvelope: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every client operation used by the contract.
  const rpcClient = client as unknown as RpcClient
  recordRuntimeStatusProbe(rpcClient, {
    runtimeId: 'runtime-1',
    hostDescriptor: { installationId: 'host-1' },
    capabilities
  })
  return {
    client: rpcClient,
    sendRequest,
    replace: () => {
      state = 'disconnected'
      listeners.forEach((listener) => listener(state))
      generation++
      state = 'connected'
    }
  }
}

it('reuses the existing execution-host status across N and 10N reads and fences replacement', async () => {
  const source = host([complete, exact])
  for (const n of [10, 100]) {
    const contracts = await Promise.all(
      Array.from({ length: n }, () =>
        captureMobilePRCheckContract(source.client, { repo: 'id:repo' })
      )
    )
    expect(contracts.every((contract) => contract.complete && contract.current())).toBe(true)
    expect(source.sendRequest).not.toHaveBeenCalled()
    contracts.forEach((contract) => contract.retire())
  }
  const pending = await captureMobilePRCheckContract(source.client, { repo: 'id:repo' })
  source.replace()
  expect(pending.current()).toBe(false)
  pending.retire()
})

it('uses the executing host verdict when a new relay points at an old host', async () => {
  const relay = host([complete, exact])
  const execution = host([])
  const routed = {
    ...relay.client,
    requestRoute: () => ({ client: execution.client, intermediary: relay.client })
  }
  const contract = await captureMobilePRCheckContract(routed, { repo: 'id:server-repo' })
  expect(contract.complete).toBe(false)
  expect(contract.options).not.toHaveProperty('envelope')
  contract.retire()
})

it('does not certify a capable execution host through an unproven old intermediary', async () => {
  const relay = host([])
  const execution = host([complete, exact])
  const routed = {
    ...relay.client,
    requestRoute: () => ({ client: execution.client, intermediary: relay.client })
  }
  const contract = await captureMobilePRCheckContract(routed, { repo: 'id:server-repo' })
  expect(contract.complete).toBe(false)
  contract.retire()
})

it('refresh relearns a relayed runtime restart without a phone connection edge', async () => {
  const execution = host([complete, exact])
  const old = await captureMobilePRCheckContract(execution.client, { repo: 'id:repo' })
  execution.sendRequest.mockResolvedValueOnce({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'runtime-2',
      hostDescriptor: { installationId: 'host-1' },
      capabilities: [complete, exact]
    }
  })
  const fresh = await captureMobilePRCheckContract(execution.client, { repo: 'id:repo' }, true)
  expect(old.current()).toBe(false)
  expect(fresh.complete && fresh.current()).toBe(true)
  expect(
    'envelope' in fresh.options && fresh.options.envelope?.expectedRuntimeSource?.runtimeId
  ).toBe('runtime-2')
  old.retire()
  fresh.retire()
})

it('retires a repository route switch while both clients stay connected', async () => {
  const first = host([complete, exact])
  const second = host([complete, exact])
  let selected = first.client
  const router = { ...first.client, requestRoute: () => ({ client: selected }) }
  const pending = await captureMobilePRCheckContract(router, { repo: 'id:repo' })
  selected = second.client
  expect(pending.current()).toBe(false)
  expect(() => 'beforeSend' in pending.options && pending.options.beforeSend()).toThrow()
  pending.retire()
})

it('uses later same-epoch probe evidence after transient discovery failure without delaying legacy reads', async () => {
  const source = host([])
  recordRuntimeStatusProbe(source.client, null)
  const deferred = Promise.withResolvers<never>()
  source.sendRequest.mockReturnValueOnce(deferred.promise)
  const legacy = await captureMobilePRCheckContract(source.client, { repo: 'id:repo' }, true)
  expect(legacy.complete).toBe(false)
  deferred.reject(new Error('temporary'))
  await Promise.resolve()
  recordRuntimeStatusProbe(source.client, {
    runtimeId: 'runtime-1',
    hostDescriptor: { installationId: 'host-1' },
    capabilities: [complete, exact]
  })
  const adopted = await captureMobilePRCheckContract(source.client, { repo: 'id:repo' })
  expect(adopted.complete && adopted.current()).toBe(true)
  expect(legacy.current()).toBe(false)
  legacy.retire()
  adopted.retire()
})

it('coalesces concurrent discovery and leaves unknown-host reads available while status is pending', async () => {
  const source = host([complete, exact])
  recordRuntimeStatusProbe(source.client, null)
  const status = Promise.withResolvers<Awaited<ReturnType<typeof source.sendRequest>>>()
  source.sendRequest.mockReturnValueOnce(status.promise)
  const reads = await Promise.all(
    Array.from({ length: 100 }, () =>
      captureMobilePRCheckContract(source.client, { repo: 'id:repo' }, true)
    )
  )
  expect(reads.every((read) => !read.complete)).toBe(true)
  expect(source.sendRequest).toHaveBeenCalledTimes(1)
  status.resolve({
    id: 's',
    ok: true,
    result: {
      runtimeId: 'runtime-1',
      hostDescriptor: { installationId: 'host-1' },
      capabilities: [complete, exact]
    }
  })
  await status.promise
  await vi.waitFor(async () => {
    const next = await captureMobilePRCheckContract(source.client, { repo: 'id:repo' })
    expect(next.complete).toBe(true)
    next.retire()
  })
  reads.forEach((read) => read.retire())
})
