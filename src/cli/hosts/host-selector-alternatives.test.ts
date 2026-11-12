import { afterEach, describe, expect, it, vi } from 'vitest'
import { listSshTargets } from './host-selector-alternatives'
import { RuntimeClient } from '../runtime/client'
import { okFixture } from '../test-fixtures'

const SSH_TARGETS = [{ id: 'ssh-1755000000000-a1b2c3', label: 'openclaw' }]

afterEach(() => vi.restoreAllMocks())

function clientWithCall(call: RuntimeClient['call']): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-host-alternatives-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  return client
}

describe('listSshTargets', () => {
  it('enriches legacy target rows from host-owned connection state', async () => {
    const { RuntimeClientError } = await import('../runtime/types.js')
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('method_not_found', 'Unknown method'))
      .mockResolvedValueOnce(okFixture('targets', { targets: SSH_TARGETS }))
      .mockResolvedValueOnce(
        okFixture('state', {
          state: { status: 'connected', remotePlatform: 'win32' }
        })
      )

    await expect(listSshTargets(clientWithCall(call))).resolves.toEqual([
      { ...SSH_TARGETS[0], connected: true, connectionStatus: 'connected', remotePlatform: 'win32' }
    ])
    expect(call).toHaveBeenCalledWith('ssh.getState', { targetId: SSH_TARGETS[0].id })
  })
})
