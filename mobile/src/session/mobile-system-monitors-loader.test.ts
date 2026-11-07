import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../src/shared/constants'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../src/shared/protocol-version'
import { FALLBACK_MOBILE_SYSTEM_MONITOR_IDS } from '../../../src/shared/system-monitors'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWorkspaceOnOtherRuntimeError } from './mobile-new-tab-agent-loader'
import { loadMobileSystemMonitors } from './mobile-system-monitors-loader'

function makeRpcClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- minimal test double for RPC request boundary
  return { sendRequest } as unknown as RpcClient
}

describe('loadMobileSystemMonitors', () => {
  it('requests preflight.detectMonitors for the workspace and resolves monitor descriptors', async () => {
    const sendRequest = vi.fn(async () => ({
      id: '1',
      ok: true as const,
      result: ['btop', 'lazydocker', 'docker-stats', 'unknown-tool']
    }))
    const result = await loadMobileSystemMonitors({
      client: makeRpcClient(sendRequest),
      worktreeId: 'repo::wt-1'
    })

    expect(sendRequest).toHaveBeenCalledWith('preflight.detectMonitors', {
      worktreeId: 'repo::wt-1'
    })
    expect(result.fallback).toBe(false)
    expect(result.monitors.map((entry) => entry.id)).toEqual([
      'btop',
      'lazydocker',
      'docker-stats'
    ])
  })

  it('omits worktreeId when probing the floating terminal sentinel', async () => {
    const sendRequest = vi.fn(async () => ({
      id: '1',
      ok: true as const,
      result: ['htop']
    }))
    const result = await loadMobileSystemMonitors({
      client: makeRpcClient(sendRequest),
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    expect(sendRequest).toHaveBeenCalledWith('preflight.detectMonitors', {})
    expect(result.monitors.map((entry) => entry.id)).toEqual(['htop'])
  })

  it('falls back to common *top and Docker presets when paired to an older host without preflight.detectMonitors', async () => {
    const sendRequest = vi.fn(async () => ({
      id: '1',
      ok: false as const,
      error: { code: 'method_not_found', message: 'Unknown method: preflight.detectMonitors' }
    }))
    const result = await loadMobileSystemMonitors({
      client: makeRpcClient(sendRequest),
      worktreeId: 'repo::wt-1'
    })

    expect(result.fallback).toBe(true)
    expect(result.monitors.map((entry) => entry.id)).toEqual([
      ...FALLBACK_MOBILE_SYSTEM_MONITOR_IDS
    ])
  })

  it('translates WORKSPACE_ON_OTHER_RUNTIME refusals into MobileWorkspaceOnOtherRuntimeError', async () => {
    const sendRequest = vi.fn(async () => ({
      id: '1',
      ok: false as const,
      error: { code: 'bad_request', message: WORKSPACE_ON_OTHER_RUNTIME }
    }))
    await expect(
      loadMobileSystemMonitors({
        client: makeRpcClient(sendRequest),
        worktreeId: 'repo::wt-1'
      })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
  })
})
