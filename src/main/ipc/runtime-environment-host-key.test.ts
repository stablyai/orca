import { describe, expect, it } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { publicRuntimeEnvironmentWithHostKey } from './runtime-environment-host-key'

function environment(publicKeyB64: string): KnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Box',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'Box',
        endpoint: 'ws://127.0.0.1:46768/',
        deviceToken: 'secret-token',
        publicKeyB64
      }
    ]
  }
}

describe('the public runtime environment record', () => {
  it('carries a stable host key digest but never the key or the device token', () => {
    const first = publicRuntimeEnvironmentWithHostKey(environment('key-a'))
    const again = publicRuntimeEnvironmentWithHostKey(environment('key-a'))
    const other = publicRuntimeEnvironmentWithHostKey(environment('key-b'))

    expect(first.hostKeyFingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(again.hostKeyFingerprint).toBe(first.hostKeyFingerprint)
    expect(other.hostKeyFingerprint).not.toBe(first.hostKeyFingerprint)
    expect(JSON.stringify(first)).not.toMatch(/key-a|secret-token/)
  })
})
