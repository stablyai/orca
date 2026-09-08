import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS } from '../../../src/shared/mobile-web/host-rpc-contract'
import {
  MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS,
  executeMobileWebHostRequest
} from './mobile-web-host-requests'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import {
  MOBILE_WEB_PRODUCTION_GRANT_INDEX,
  MOBILE_WEB_PRODUCTION_GRANTS
} from './mobile-web-production-grants'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'

const METHOD = 'future.domainRead'

function fixture() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(1))
  authority.synchronize(['host-workspace'])
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const args = {
    authority,
    client: { sendRequest } as unknown as RpcClient,
    isActive: () => true,
    payload: {
      method: METHOD,
      workspaceId: authority.pageWorkspaceId('host-workspace'),
      params: { futureField: { futureVariant: 'added-by-desktop' } }
    }
  }
  return { args, sendRequest }
}

describe('host-advertised unary forwarding', () => {
  it('forwards future fields and methods without a shell method entry', async () => {
    const { args, sendRequest } = fixture()
    const result = { futureResult: [{ kind: 'future-kind', value: 4 }] }
    sendRequest.mockResolvedValueOnce({ ok: true, result })
    await expect(executeMobileWebHostRequest(args)).resolves.toEqual(result)
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith(
      METHOD,
      { ...args.payload.params, worktree: 'id:host-workspace' },
      expect.objectContaining({ beforeSend: expect.any(Function), budgetSpansConnect: true })
    )
    expect(JSON.stringify(result)).not.toContain('host-workspace')
  })

  it.each(['cancel', 'rebind'] as const)('revalidates %s at transport dispatch', async (change) => {
    const { args, sendRequest } = fixture()
    let active = true
    args.isActive = () => active
    sendRequest.mockImplementationOnce(async (_method, _params, options) => {
      if (change === 'cancel') {
        active = false
      } else {
        args.authority.clear()
      }
      options?.beforeSend?.()
      throw new Error('Transport must not write')
    })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({
      code: change === 'cancel' ? 'cancelled' : 'not_found'
    })
  })

  it('does not forward a workspace handle the authority no longer binds', async () => {
    const { args, sendRequest } = fixture()
    args.authority.clear()
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'not_found' })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it.each(['future.feed.subscribe', 'future.files.watch'])(
    'refuses %s in the unary lane, whose stream frames it could never settle on',
    async (method) => {
      const { args, sendRequest } = fixture()
      args.payload = { ...args.payload, method }
      await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({
        code: 'unsupported_capability'
      })
      expect(sendRequest).not.toHaveBeenCalled()
    }
  )

  it('refuses a response larger than the bridge envelope', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockResolvedValueOnce({ ok: true, result: { text: 'x'.repeat(640 * 1024) } })
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('refuses a request larger than the bridge envelope before sending it', async () => {
    const { args, sendRequest } = fixture()
    args.payload = { ...args.payload, params: { text: 'x'.repeat(640 * 1024) } }
    await expect(executeMobileWebHostRequest(args)).rejects.toMatchObject({ code: 'too_large' })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('retains in-flight admission after page cancellation until host work settles', async () => {
    const finishHostRead: (() => void)[] = []
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async (method) => {
      if (method === 'worktree.ps') {
        return {
          ok: true,
          result: {
            worktrees: [{ worktreeId: 'host-workspace', repo: '/repo', displayName: 'Workspace' }]
          }
        }
      }
      return new Promise((resolve) =>
        finishHostRead.push(() => resolve({ ok: true, result: { entries: [] } }))
      )
    })
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const snapshot = await client.workspaceSnapshot({ limit: 10 })
    const payload = { workspaceId: snapshot.workspaces[0]!.id, limit: 10 }
    const ceiling =
      MOBILE_WEB_PRODUCTION_GRANT_INDEX.get('workspace.hostRequest')!.limits.maxConcurrent
    for (let i = 0; i < ceiling; i++) {
      const controller = new AbortController()
      const pending = client.sourceControlStatus(payload, { signal: controller.signal })
      const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      controller.abort()
      await rejection
    }
    await expect(client.sourceControlStatus(payload)).rejects.toMatchObject({
      code: 'rate_limited'
    })
    expect(finishHostRead).toHaveLength(ceiling)
    finishHostRead.forEach((finish) => finish())
  })

  it('renders bounded Desktop status through the generic host lane', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async (method) => {
      if (method === 'worktree.ps') {
        return {
          ok: true,
          result: {
            worktrees: [{ worktreeId: 'host-workspace', repo: '/repo', displayName: 'Workspace' }]
          }
        }
      }
      expect(method).toBe('mobileWeb.sourceControl.status')
      return {
        ok: true,
        result: {
          entries: [],
          conflictOperation: 'unknown',
          branch: 'main',
          totalCount: 0,
          truncated: false
        }
      }
    })
    const { client, pageMessages } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const snapshot = await client.workspaceSnapshot({ limit: 10 })
    const workspaceId = snapshot.workspaces[0]!.id
    await expect(client.sourceControlStatus({ workspaceId, limit: 10 })).resolves.toMatchObject({
      workspaceId,
      branch: 'main',
      entries: []
    })
    expect(
      pageMessages.some(
        (message) => message.type === 'request' && message.operation === 'hostRequest'
      )
    ).toBe(true)
    expect(
      pageMessages.some((message) => message.type === 'request' && message.operation === 'status')
    ).toBe(false)
  })
})

describe('page-declared host deadlines', () => {
  it('gives the host call the page deadline instead of the shell default', async () => {
    const { args, sendRequest } = fixture()
    args.payload = { ...args.payload, timeoutMs: 120_000 }
    sendRequest.mockResolvedValueOnce({ ok: true, result: {} })
    await executeMobileWebHostRequest(args)
    const options = sendRequest.mock.calls[0]![2]!
    expect(options.timeoutMs).toBeGreaterThan(MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS)
    expect(options.timeoutMs).toBeLessThanOrEqual(120_000)
  })

  it('falls back to the shell default when the page names no deadline', async () => {
    const { args, sendRequest } = fixture()
    sendRequest.mockResolvedValueOnce({ ok: true, result: {} })
    await executeMobileWebHostRequest(args)
    expect(sendRequest.mock.calls[0]![2]!.timeoutMs).toBeLessThanOrEqual(
      MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS
    )
  })

  it('refuses a deadline past the envelope ceiling', async () => {
    const { args, sendRequest } = fixture()
    args.payload = { ...args.payload, timeoutMs: MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS + 1000 }
    await expect(executeMobileWebHostRequest(args)).rejects.toThrow()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
