import { expect, it } from 'vitest'
import { describeClientConnection } from './runtime-rpc-client-connection-log'

it('names the connecting device without its credentials', () => {
  const described = describeClientConnection({
    connectionId: 'conn-1',
    transport: { transport: 'direct' },
    device: {
      deviceId: 'device-1',
      scope: 'mobile',
      clientId: 'bearer-secret',
      callerFingerprint: 'fingerprint',
      credentialRevision: 1,
      deviceToken: 'token-secret'
    }
  })

  expect(described).toEqual({
    deviceId: 'device-1',
    scope: 'mobile',
    transport: 'direct',
    connectionId: 'conn-1'
  })
})
