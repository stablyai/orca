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

const selfOwner = 'owner:desktop:self'
const sshOwner = 'owner:desktop:ssh:target-a:3'

describe('ExternalAutomationManagerCache', () => {
  it('keeps each owner’s manager and failure separate', () => {
    const cache = new ExternalAutomationManagerCache()
    const failedOwner = 'owner:desktop:ssh:target-b:1'

    cache.write({ ownerKey: selfOwner, provider: 'openclaw' }, manager('openclaw:local'))
    cache.writeFailure({ ownerKey: failedOwner, provider: 'openclaw' }, new Error('no openclaw'))
    cache.write({ ownerKey: sshOwner, provider: 'openclaw' }, manager('openclaw:ssh:target-a'))

    expect(cache.read({ ownerKey: selfOwner, provider: 'openclaw' })?.manager?.id).toBe(
      'openclaw:local'
    )
    expect(cache.read({ ownerKey: failedOwner, provider: 'openclaw' })?.error).toBe('no openclaw')
    expect(cache.read({ ownerKey: selfOwner, provider: 'openclaw' })?.error).toBeNull()
    expect(cache.read({ ownerKey: sshOwner, provider: 'openclaw' })?.manager?.id).toBe(
      'openclaw:ssh:target-a'
    )
  })

  it('drops only the named host when a mutation invalidates it', () => {
    const cache = new ExternalAutomationManagerCache()
    cache.write({ ownerKey: selfOwner, provider: 'openclaw' }, manager('openclaw:local'))
    cache.write({ ownerKey: sshOwner, provider: 'openclaw' }, manager('openclaw:ssh:target-a'))

    cache.invalidateOwner(sshOwner)

    expect(cache.read({ ownerKey: selfOwner, provider: 'openclaw' })).not.toBeNull()
    expect(cache.read({ ownerKey: sshOwner, provider: 'openclaw' })).toBeNull()
  })

  it('treats an entry past its TTL as absent', () => {
    let now = 1_000
    const cache = new ExternalAutomationManagerCache({ ttlMs: 100, now: () => now })
    cache.write({ ownerKey: selfOwner, provider: 'openclaw' }, manager('openclaw:local'))

    now += 100
    expect(cache.read({ ownerKey: selfOwner, provider: 'openclaw' })).not.toBeNull()
    now += 1
    expect(cache.read({ ownerKey: selfOwner, provider: 'openclaw' })).toBeNull()
  })

  it('records a load failure as error state rather than throwing', async () => {
    const cache = new ExternalAutomationManagerCache()

    const entry = await cache.resolve({ ownerKey: sshOwner, provider: 'openclaw' }, () =>
      Promise.reject(new Error('relay refused'))
    )

    expect(entry.manager).toBeNull()
    expect(entry.error).toBe('relay refused')
  })

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
