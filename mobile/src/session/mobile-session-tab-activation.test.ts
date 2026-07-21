import { describe, expect, it, vi } from 'vitest'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { activateMobileSessionTab, focusMobileTerminal } from './mobile-session-tab-activation'

function success(): RpcResponse {
  return { id: 'rpc-1', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
}

function clientWith(sendRequest: RpcClient['sendRequest']): Pick<RpcClient, 'sendRequest'> {
  return { sendRequest }
}

describe('mobile session tab activation', () => {
  it('retries terminal focus once on the authenticated replacement after cutover', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockRejectedValueOnce(new LogicalClientCutoverError())
      .mockResolvedValueOnce(success())

    await expect(focusMobileTerminal(clientWith(sendRequest), 'terminal-1')).resolves.toMatchObject(
      {
        ok: true
      }
    )
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest).toHaveBeenNthCalledWith(1, 'terminal.focus', {
      terminal: 'terminal-1',
      navigation: 'host'
    })
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'terminal.focus', {
      terminal: 'terminal-1',
      navigation: 'host'
    })
  })

  it('retries session-tab activation with the same target after cutover', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockRejectedValueOnce(new LogicalClientCutoverError())
      .mockResolvedValueOnce(success())
    const params = {
      worktree: 'id:worktree-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      notifyClients: false as const,
      navigation: 'caller' as const
    }

    await expect(activateMobileSessionTab(clientWith(sendRequest), params)).resolves.toMatchObject({
      ok: true
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest).toHaveBeenNthCalledWith(1, 'session.tabs.activate', params)
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'session.tabs.activate', params)
  })

  it('does not retry unrelated transport failures', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockRejectedValue(new Error('offline'))

    await expect(focusMobileTerminal(clientWith(sendRequest), 'terminal-1')).rejects.toThrow(
      'offline'
    )
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('retries at most once when consecutive cutovers interrupt activation', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockRejectedValue(new LogicalClientCutoverError())

    await expect(
      activateMobileSessionTab(clientWith(sendRequest), {
        worktree: 'id:worktree-1',
        tabId: 'tab-1',
        notifyClients: false,
        navigation: 'caller'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
