import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { nativeHostSessionQuickCommandOperations } from './native-host-session-quick-command-operations'

const client = (sendRequest: RpcClient['sendRequest']): RpcClient =>
  ({ sendRequest }) as unknown as RpcClient

describe('native host session quick command operations', () => {
  it('replays the load only when the transport rejected with a cutover', async () => {
    let attempts = 0
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new LogicalClientCutoverError()
      }
      return {
        id: 'test',
        _meta: { runtimeId: 'host' },
        ok: true,
        result: { terminalQuickCommands: [] }
      }
    })

    await expect(
      nativeHostSessionQuickCommandOperations(client(sendRequest)).snapshot()
    ).resolves.toMatchObject({ commands: [] })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('does not replay a refusal envelope, whatever message it carries', async () => {
    // A host refusal is an answer. Checking `ok` inside the retry would replay it up to five
    // times whenever the host's own error text happened to match the cutover string.
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      id: 'test',
      _meta: { runtimeId: 'host' },
      ok: false,
      error: { code: 'failed', message: 'RPC interrupted by connection migration' }
    })

    await expect(
      nativeHostSessionQuickCommandOperations(client(sendRequest)).snapshot()
    ).rejects.toThrow('RPC interrupted by connection migration')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
