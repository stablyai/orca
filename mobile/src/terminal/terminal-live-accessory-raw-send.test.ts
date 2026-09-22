import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveAccessoryRawBytes } from './terminal-live-accessory-raw-send'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

function captureClient(
  result: Promise<unknown> = Promise.resolve({
    id: 'send',
    ok: true,
    result: { send: { handle: 'terminal-a', accepted: true, bytesWritten: 1 } },
    _meta: { runtimeId: 'test-runtime' }
  })
) {
  const sendRequest = vi.fn(() => result)
  return { client: { sendRequest } as unknown as Pick<RpcClient, 'sendRequest'>, sendRequest }
}

const BASE_ARGS = {
  targetHandle: 'terminal-a',
  activeHandle: 'terminal-a',
  activeSessionTabType: 'terminal',
  connState: 'connected',
  bytes: '',
  deviceToken: 'tok'
} as const

describe('terminal live accessory raw send', () => {
  it('sends raw bytes now-or-never with the device presence tag', async () => {
    const { client, sendRequest } = captureClient()

    await expect(sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client })).resolves.toBe(true)

    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      { terminal: 'terminal-a', text: '', enter: false, client: { id: 'tok', type: 'mobile' } },
      // Why: an accessory key parked in the connect wait would fire into the PTY long after the tap.
      { failWhenDisconnected: true }
    )
  })

  it('drops the bytes instead of sending while disconnected', async () => {
    const { client, sendRequest } = captureClient()

    await expect(
      sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client, connState: 'reconnecting' })
    ).resolves.toBe(false)

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('drops the bytes when the terminal selection went stale mid-flush', async () => {
    const { client, sendRequest } = captureClient()

    await expect(
      sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client, activeHandle: 'terminal-b' })
    ).resolves.toBe(false)

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('reports a rejected send without surfacing transport errors', async () => {
    const { client } = captureClient(Promise.reject(new Error('Not connected: terminal.send')))

    await expect(sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client })).resolves.toBe(false)
  })

  it('reports a fulfilled RPC failure as a failed send', async () => {
    const response: RpcResponse = {
      id: 'send',
      ok: false,
      error: { code: 'terminal_error', message: 'failed' },
      _meta: { runtimeId: 'test-runtime' }
    }
    const { client } = captureClient(Promise.resolve(response))

    await expect(sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client })).resolves.toBe(false)
  })
})
