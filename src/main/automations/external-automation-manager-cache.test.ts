import { describe, expect, it, vi } from 'vitest'
import {
  ExternalAutomationManagerCache,
  describeExternalManagerFailure
} from './external-automation-manager-cache'
import { ExternalAutomationProbeCancelledError } from './external-automation-probe-scheduler'
import type { ExternalAutomationManager } from '../../shared/automations-types'

function manager(id: string): ExternalAutomationManager {
  return {
    id,
    provider: 'hermes',
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
  it('keys entries per owner and per provider', () => {
    const cache = new ExternalAutomationManagerCache()

    cache.write({ ownerKey: selfOwner, provider: 'hermes' }, manager('hermes:local'))
    cache.writeFailure({ ownerKey: selfOwner, provider: 'openclaw' }, new Error('no openclaw'))
    cache.write({ ownerKey: sshOwner, provider: 'hermes' }, manager('hermes:ssh:target-a'))

    expect(cache.read({ ownerKey: selfOwner, provider: 'hermes' })?.manager?.id).toBe(
      'hermes:local'
    )
    expect(cache.read({ ownerKey: selfOwner, provider: 'openclaw' })?.error).toBe('no openclaw')
    expect(cache.read({ ownerKey: selfOwner, provider: 'hermes' })?.error).toBeNull()
    expect(cache.read({ ownerKey: sshOwner, provider: 'hermes' })?.manager?.id).toBe(
      'hermes:ssh:target-a'
    )
  })

  it('drops only the named host when a mutation invalidates it', () => {
    const cache = new ExternalAutomationManagerCache()
    cache.write({ ownerKey: selfOwner, provider: 'hermes' }, manager('hermes:local'))
    cache.write({ ownerKey: sshOwner, provider: 'hermes' }, manager('hermes:ssh:target-a'))
    cache.write({ ownerKey: sshOwner, provider: 'openclaw' }, manager('openclaw:ssh:target-a'))

    cache.invalidateOwner(sshOwner)

    expect(cache.read({ ownerKey: selfOwner, provider: 'hermes' })).not.toBeNull()
    expect(cache.read({ ownerKey: sshOwner, provider: 'hermes' })).toBeNull()
    expect(cache.read({ ownerKey: sshOwner, provider: 'openclaw' })).toBeNull()
  })

  it('treats an entry past its TTL as absent', () => {
    let now = 1_000
    const cache = new ExternalAutomationManagerCache({ ttlMs: 100, now: () => now })
    cache.write({ ownerKey: selfOwner, provider: 'hermes' }, manager('hermes:local'))

    now += 100
    expect(cache.read({ ownerKey: selfOwner, provider: 'hermes' })).not.toBeNull()
    now += 1
    expect(cache.read({ ownerKey: selfOwner, provider: 'hermes' })).toBeNull()
  })

  it('prunes expired entries when the cache is accessed', () => {
    let now = 1_000
    const cache = new ExternalAutomationManagerCache({ ttlMs: 100, now: () => now })
    for (let index = 0; index < 10; index += 1) {
      cache.write({ ownerKey: `owner-${index}`, provider: 'hermes' }, manager(String(index)))
    }
    now += 101

    expect(cache.read({ ownerKey: 'unrelated', provider: 'hermes' })).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('serves a fresh entry without reloading, and reloads on refresh', async () => {
    const cache = new ExternalAutomationManagerCache()
    const load = vi.fn(() => Promise.resolve(manager('hermes:local')))
    const key = { ownerKey: selfOwner, provider: 'hermes' }

    await cache.resolve(key, load)
    await cache.resolve(key, load)
    expect(load).toHaveBeenCalledTimes(1)

    await cache.resolve(key, load, { refresh: true })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('records a load failure as error state rather than throwing', async () => {
    const cache = new ExternalAutomationManagerCache()

    const entry = await cache.resolve({ ownerKey: sshOwner, provider: 'hermes' }, () =>
      Promise.reject(new Error('relay refused'))
    )

    expect(entry.manager).toBeNull()
    expect(entry.error).toBe('relay refused')
  })

  it('propagates cancellation and leaves the previous entry untouched', async () => {
    const cache = new ExternalAutomationManagerCache()
    const key = { ownerKey: sshOwner, provider: 'hermes' }
    cache.write(key, manager('hermes:ssh:target-a'))

    await expect(
      cache.resolve(key, () => Promise.reject(new ExternalAutomationProbeCancelledError()), {
        refresh: true
      })
    ).rejects.toBeInstanceOf(ExternalAutomationProbeCancelledError)
    expect(cache.read(key)?.manager?.id).toBe('hermes:ssh:target-a')
  })
})

describe('describeExternalManagerFailure', () => {
  it('keeps only a bounded message and never the thrown payload', () => {
    expect(describeExternalManagerFailure({ prompt: 'secret prompt', jobs: [1, 2] })).toBe(
      'External automation manager could not be read.'
    )
    expect(describeExternalManagerFailure(new Error('  '))).toBe(
      'External automation manager could not be read.'
    )

    const long = describeExternalManagerFailure(new Error('x'.repeat(400)))
    expect(long).toHaveLength(301)
    expect(long.endsWith('…')).toBe(true)
  })
})
