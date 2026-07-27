import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'

describe('RuntimeClient updater methods', () => {
  const client = new RuntimeClient('/tmp/orca-updater-client-test', 100, null, null)
  const call = vi.spyOn(client, 'call')

  beforeEach(() => {
    call.mockReset().mockResolvedValue({
      id: 'req-1',
      ok: true,
      result: { status: { state: 'idle' }, revision: 0 },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('reads the snapshot and long-polls for status changes', async () => {
    await client.getUpdateStatus()
    await client.waitForUpdateStatus(4, 25_000)

    expect(call).toHaveBeenNthCalledWith(1, 'updater.getStatus')
    expect(call).toHaveBeenNthCalledWith(2, 'updater.wait', {
      afterRevision: 4,
      timeoutMs: 25_000
    })
  })

  it('maps check options and update actions', async () => {
    await client.checkForUpdate(true)
    await client.downloadUpdate()
    await client.installUpdate()

    expect(call).toHaveBeenNthCalledWith(1, 'updater.check', { includePrerelease: true })
    expect(call).toHaveBeenNthCalledWith(2, 'updater.download')
    expect(call).toHaveBeenNthCalledWith(3, 'updater.install')
  })
})
