import { terminalInputSend } from './mobile-terminal-operations'
import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveAccessoryRawBytes } from './terminal-live-accessory-raw-send'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

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
  sendTerminalUserInput: terminalInputSend.request,
  targetHandle: 'terminal-a',
  activeHandle: 'terminal-a',
  activeSessionTabType: 'terminal',
  connState: 'connected',
  bytes: '',
  deviceToken: 'tok'
} as const

describe('terminal live accessory raw send', () => {
  it('drops the bytes when the terminal selection went stale mid-flush', async () => {
    const { client, sendRequest } = captureClient()

    await expect(
      sendTerminalLiveAccessoryRawBytes({ ...BASE_ARGS, client, activeHandle: 'terminal-b' })
    ).resolves.toBe(false)

    expect(sendRequest).not.toHaveBeenCalled()
  })
})
