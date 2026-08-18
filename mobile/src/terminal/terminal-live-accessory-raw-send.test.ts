import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveAccessoryRawBytes } from './terminal-live-accessory-raw-send'
import type { RpcClient } from '../transport/rpc-client'

function captureClient(result: Promise<unknown> = Promise.resolve({ ok: true })) {
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

    await sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client })

    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      { terminal: 'terminal-a', text: '', enter: false, client: { id: 'tok', type: 'mobile' } },
      // Why: an accessory key parked in the connect wait would fire into the PTY long after the tap.
      { failWhenDisconnected: true }
    )
  })

  it('drops the bytes instead of sending while disconnected', async () => {
    const { client, sendRequest } = captureClient()

    await sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client, connState: 'reconnecting' })

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('drops the bytes when the terminal selection went stale mid-flush', async () => {
    const { client, sendRequest } = captureClient()

    await sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client, activeHandle: 'terminal-b' })

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('swallows a rejected send so accessory taps never surface transport errors', async () => {
    const { client } = captureClient(Promise.reject(new Error('Not connected: terminal.send')))

    await expect(
      sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client })
    ).resolves.toBeUndefined()
  })
})
