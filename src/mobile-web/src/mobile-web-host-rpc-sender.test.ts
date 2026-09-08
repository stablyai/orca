import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS } from '../../shared/mobile-web/host-rpc-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { mobileWebHostRpcSender } from './mobile-web-host-rpc-sender'
import { MobileWebHostRequestClient } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

function fixture(result: unknown, reject = false) {
  const request = reject ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result)
  return {
    request,
    sender: mobileWebHostRpcSender({ request } as unknown as MobileWebOneShotRequestClient)
  }
}

describe('host RPC sender', () => {
  it('answers in the shape desktop request code already expects', async () => {
    const f = fixture({ repos: [] })

    await expect(f.sender.sendRequest('repo.list')).resolves.toMatchObject({
      ok: true,
      result: { repos: [] }
    })
    expect(f.request).toHaveBeenCalledWith(
      'workspace',
      'hostRequest',
      { method: 'repo.list', params: {} },
      expect.anything(),
      expect.anything(),
      undefined
    )
  })

  it('turns a bridge failure into a failed response instead of throwing', async () => {
    const f = fixture(new MobileWebBridgeClientError('not_found', false), true)

    await expect(f.sender.sendRequest('repo.hooks', { repo: 'id:repo-1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
  })

  it('carries a long deadline to the shell so an SSH connect is not cut short', async () => {
    const f = fixture({ state: null })

    await f.sender.sendRequest('ssh.connect', { targetId: 'host-1' }, { timeoutMs: 120_000 })

    expect(f.request.mock.calls[0]![2]).toMatchObject({ timeoutMs: 120_000 })
  })

  it('clamps a deadline the envelope would reject', async () => {
    const f = fixture({})

    await f.sender.sendRequest('ssh.connect', {}, { timeoutMs: 10 * 60_000 })

    expect(f.request.mock.calls[0]![2]).toMatchObject({
      timeoutMs: MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS
    })
    expect(f.request.mock.calls[0]!.at(-1)).toMatchObject({
      timeoutMs: MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS
    })
  })

  it('honors a generic request payload deadline while preserving cancellation', async () => {
    const f = fixture({})
    const client = new MobileWebHostRequestClient({
      request: f.request
    } as unknown as MobileWebOneShotRequestClient)
    const signal = new AbortController().signal

    await client.request({ method: 'ssh.connect', params: {}, timeoutMs: 120_000 }, { signal })

    expect(f.request.mock.calls[0]![2]).toMatchObject({ timeoutMs: 120_000 })
    expect(f.request.mock.calls[0]!.at(-1)).toEqual({ timeoutMs: 120_000, signal })

    await client.request(
      { method: 'ssh.connect', params: {}, timeoutMs: 120_000 },
      { signal, timeoutMs: 60_000 }
    )

    expect(f.request.mock.calls[1]![2]).toMatchObject({ timeoutMs: 60_000 })
    expect(f.request.mock.calls[1]!.at(-1)).toEqual({ timeoutMs: 60_000, signal })
  })
})
