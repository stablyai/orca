import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { readMobileSshTargetLabels } from './use-mobile-ssh-target-labels'

describe('readMobileSshTargetLabels', () => {
  it('maps target ids to the display labels published by the host', async () => {
    const client = {
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: { targets: [{ id: 'ssh-1724000000000-abc123', label: 'devbox' }] }
      })
    } as unknown as RpcClient

    await expect(readMobileSshTargetLabels(client)).resolves.toEqual(
      new Map([['ssh-1724000000000-abc123', 'devbox']])
    )
  })

  it('returns an empty map when an older host rejects the method', async () => {
    const client = {
      sendRequest: vi.fn().mockRejectedValue(new Error('method not found'))
    } as unknown as RpcClient

    await expect(readMobileSshTargetLabels(client)).resolves.toEqual(new Map())
  })
})
