import { describe, expect, it } from 'vitest'
import { getSelfHostedRelayConfig, selfHostedRelayAuthContext } from './self-hosted-relay-config'

const env = {
  url: 'https://relay.example.test',
  accessKey: 'owner-access-key-with-at-least-32-characters'
}

describe('self-hosted desktop Relay configuration', () => {
  it('leaves ordinary builds unchanged and scopes owner identity to the chosen server', () => {
    const config = getSelfHostedRelayConfig(env, true)!
    expect(config.relayTokenEndpoint).toBe('https://relay.example.test/v1/host-token')
    expect(selfHostedRelayAuthContext(config)).toEqual({
      identity: {
        userId: 'self-hosted',
        profileId: env.url,
        organizationId: ''
      },
      accessToken: env.accessKey,
      relayEntitled: true
    })
  })

  it('rejects incomplete or unsafe configuration without falling back to cloud credentials', () => {
    for (const url of [
      '',
      'http://relay.example.test',
      'https://user:password@relay.example.test',
      'https://relay.example.test/path',
      'https://relay.example.test?key=value',
      'not-a-url'
    ]) {
      expect(() => getSelfHostedRelayConfig({ ...env, url: url }, true)).toThrow()
    }
    expect(() => getSelfHostedRelayConfig({ url: env.url, accessKey: '' }, true)).toThrow()
    expect(() => getSelfHostedRelayConfig({ ...env, accessKey: 'short' }, true)).toThrow()
    const local = { ...env, url: 'http://127.0.0.1:8080' }
    expect(() => getSelfHostedRelayConfig(local, true)).toThrow()
    expect(getSelfHostedRelayConfig(local, false)?.relayDirectorUrl).toBe(local.url)
  })
})
