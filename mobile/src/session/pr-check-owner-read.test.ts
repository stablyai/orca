import { expect, it, vi } from 'vitest'
import { fetchPRForBranch } from './github-pr-rpc'
import { GITHUB_CONNECTION_CHANGED } from '../transport/github-target-invocation'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { recordRuntimeStatusProbe } from '../transport/runtime-status-probe'
import { isCompletePRCheckOwner } from '../../../src/shared/github/complete-pr-check-owner'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as complete } from '../../../src/shared/source-control/runtime/source-control-runtime-capabilities'
const status = (runtimeId: string) => ({
  runtimeId,
  hostDescriptor: { installationId: 'host' },
  capabilities: [complete]
})
const pr = {
  number: 42,
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/42',
  headSha: 'h1',
  checksStatus: 'failure',
  checksSummary: { state: 'failure', total: 101, passed: 100, failed: 1, pending: 0, neutral: 0 }
}

it.each(['adoption', 'restart'])(
  'makes one fresh exact read after %s and settles a complete owner',
  async (mode) => {
    let reads = 0
    const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => {
      if (method === 'status.get') {
        return { id: 'status', ok: true, result: status(mode === 'restart' ? 'r2' : 'r1') }
      }
      reads++
      if (reads === 1 && mode === 'restart') {
        return {
          id: 'pr',
          ok: false,
          error: { code: 'runtime_source_mismatch', message: 'source changed' }
        }
      }
      if (reads === 1 && mode === 'adoption') {
        recordRuntimeStatusProbe(client, status('r1'))
      }
      return { id: 'pr', ok: true, result: pr }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the request and connected invocation lifecycle this read uses.
    const client = {
      sendRequest,
      getState: () => 'connected',
      getGeneration: () => 1,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {}
    } as unknown as RpcClient
    recordRuntimeStatusProbe(client, mode === 'restart' ? status('r1') : null)
    const result = await fetchPRForBranch(client, 'worktree', { branch: 'feature' })
    expect(result.ok && result.result && isCompletePRCheckOwner(result.result)).toBe(true)
    expect(reads).toBe(2)
    expect(sendRequest.mock.calls.filter(([method]) => method === 'status.get')).toHaveLength(
      mode === 'restart' ? 1 : 0
    )
  }
)

function unknownReadSource() {
  const probe = Promise.withResolvers<RpcResponse>()
  const sendRequest = vi.fn(
    (method: string, _params?: unknown, _options?: SendRequestOptions): Promise<RpcResponse> =>
      method === 'status.get' ? probe.promise : Promise.resolve({ id: 'pr', ok: true, result: pr })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the connected request lifecycle used by production PR reads.
  const client = {
    sendRequest,
    getState: () => 'connected',
    getGeneration: () => 1,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {}
  } as unknown as RpcClient
  return { client, probe, sendRequest }
}

it('settles an ordinary unknown-host PR while discovery is pending and never certifies that old reply', async () => {
  const source = unknownReadSource()
  const first = await fetchPRForBranch(source.client, 'repo-9::/w', { branch: 'feature' })
  expect(first).toMatchObject({
    ok: true,
    result: { number: 42, checksStatus: 'failure', headSha: 'h1' }
  })
  expect(first.ok && first.result && isCompletePRCheckOwner(first.result)).toBe(false)
  expect(source.sendRequest).toHaveBeenCalledWith(
    'github.prForBranch',
    {
      repo: 'id:repo-9',
      branch: 'feature',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      currentHeadOid: null
    },
    expect.objectContaining({ beforeSend: expect.any(Function) })
  )
  const discovery = source.sendRequest.mock.calls.find(([method]) => method === 'status.get')!
  expect(discovery).toEqual([
    'status.get',
    undefined,
    { timeoutMs: 15_000, failWhenDisconnected: true, beforeSend: expect.any(Function) }
  ])
  expect(() => discovery[2]!.beforeSend!()).not.toThrow()
  source.probe.resolve({ id: 'status', ok: true, result: status('r1') })
  await vi.waitFor(() => {
    expect(() => discovery[2]!.beforeSend!()).toThrow(GITHUB_CONNECTION_CHANGED)
  })
  expect(first.ok && first.result && isCompletePRCheckOwner(first.result)).toBe(false)
  const fresh = await fetchPRForBranch(source.client, 'repo-9::/w', { branch: 'feature' })
  expect(fresh).toMatchObject({
    ok: true,
    result: { number: 42, checksSummary: { total: 101, passed: 100, failed: 1 } }
  })
  expect(fresh.ok && fresh.result && isCompletePRCheckOwner(fresh.result)).toBe(true)
})

it.each(['rejected', 'refused'])(
  'keeps ordinary legacy PR reads useful after discovery is %s',
  async (outcome) => {
    const source = unknownReadSource()
    const first = await fetchPRForBranch(source.client, 'repo-9::/w', { branch: 'feature' })
    expect(first).toMatchObject({ ok: true, result: { number: 42, checksStatus: 'failure' } })
    const discovery = source.sendRequest.mock.calls.find(([method]) => method === 'status.get')!
    if (outcome === 'rejected') {
      source.probe.reject(new Error('transport unavailable'))
    } else {
      source.probe.resolve({
        id: 'status',
        ok: false,
        error: { code: 'refused', message: 'refused' }
      })
    }
    await vi.waitFor(() => {
      expect(() => discovery[2]!.beforeSend!()).toThrow(GITHUB_CONNECTION_CHANGED)
    })
    const next = await fetchPRForBranch(source.client, 'repo-9::/w', { branch: 'feature' })
    expect(next).toMatchObject({ ok: true, result: { number: 42, checksStatus: 'failure' } })
    expect(next.ok && next.result && isCompletePRCheckOwner(next.result)).toBe(false)
  }
)
