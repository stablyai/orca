import { describe, expect, it } from 'vitest'
import { ExternalAutomationManagerCache } from './external-automation-manager-cache'
import { ExternalAutomationProbeCancelledError } from './external-automation-probe-scheduler'
import type { ExternalAutomationManager } from '../../../shared/automations/external/external-automation'

function manager(id: string): ExternalAutomationManager {
  return {
    id,
    provider: 'openclaw',
    label: id,
    targetLabel: 'this computer',
    target: { type: 'local' },
    status: 'available',
    error: null,
    canManage: true,
    jobs: []
  }
}

const sshOwner = 'owner:desktop:ssh:target-a:3'

describe('ExternalAutomationManagerCache', () => {
  it('propagates cancellation and leaves the previous entry untouched', async () => {
    const cache = new ExternalAutomationManagerCache()
    const key = { ownerKey: sshOwner, provider: 'openclaw' }
    cache.write(key, manager('openclaw:ssh:target-a'))

    await expect(
      cache.resolve(key, () => Promise.reject(new ExternalAutomationProbeCancelledError()), {
        refresh: true
      })
    ).rejects.toBeInstanceOf(ExternalAutomationProbeCancelledError)
    expect(cache.read(key)?.manager?.id).toBe('openclaw:ssh:target-a')
  })
})
