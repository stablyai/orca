import { describe, expect, it, vi } from 'vitest'
import {
  isSshRelayGenerationChange,
  retireSshRelayGenerationLeases,
  shouldBroadcastSshRelayGenerationRetired
} from './ssh-relay-generation-reset'

describe('isSshRelayGenerationChange', () => {
  it('is false until both sides have a build id', () => {
    expect(isSshRelayGenerationChange(undefined, '0.1.0+new')).toBe(false)
    expect(isSshRelayGenerationChange('0.1.0+old', undefined)).toBe(false)
    expect(isSshRelayGenerationChange(undefined, undefined)).toBe(false)
  })

  it('is false when the relay bundle did not move', () => {
    expect(isSshRelayGenerationChange('0.1.0+same', '0.1.0+same')).toBe(false)
  })

  it('is true only when this client last spoke a different bundle', () => {
    expect(isSshRelayGenerationChange('0.1.0+old', '0.1.0+new')).toBe(true)
  })
})

describe('retireSshRelayGenerationLeases', () => {
  it('expires every lease on the target so the new generation cannot reattach them', () => {
    const store = { markSshRemotePtyLeases: vi.fn() }
    retireSshRelayGenerationLeases(store, 'ssh-1')
    expect(store.markSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1', 'expired')
  })
})

describe('shouldBroadcastSshRelayGenerationRetired', () => {
  it('does not broadcast for runtime-owned targets', () => {
    expect(shouldBroadcastSshRelayGenerationRetired('runtime-ssh-vm-1')).toBe(false)
  })

  it('broadcasts for a user SSH target', () => {
    expect(shouldBroadcastSshRelayGenerationRetired('ssh-1')).toBe(true)
  })
})
