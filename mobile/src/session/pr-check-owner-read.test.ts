import { expect, it, vi } from 'vitest'
import { fetchPRForBranch } from './github-pr-rpc'
import type { RpcClient } from '../transport/rpc-client'
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
