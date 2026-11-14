import { describe, expect, it } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
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
  it('never exposes the host key or device token', () => {
    const first = publicRuntimeEnvironmentWithHostKey(environment('key-a'))

    expect(JSON.stringify(first)).not.toMatch(/key-a|secret-token/)
  })
})
