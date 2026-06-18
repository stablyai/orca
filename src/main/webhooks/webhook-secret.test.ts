import { createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'
import { generateWebhookSecret, verifyWebhookSecret } from './webhook-secret'

describe('generateWebhookSecret', () => {
  it('produces a 64-char hex string', () => {
    const s = generateWebhookSecret()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is unique per call', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret())
  })
})

describe('verifyWebhookSecret — none', () => {
  it('accepts any request', () => {
    expect(
      verifyWebhookSecret({
        config: { enabled: true, secretMode: 'none', secret: null },
        headers: {},
        rawBody: 'anything'
      }).ok
    ).toBe(true)
  })
})

describe('verifyWebhookSecret — token', () => {
  const config = { enabled: true, secretMode: 'token' as const, secret: 'topsecret' }

  it('accepts the X-Webhook-Token header', () => {
    expect(
      verifyWebhookSecret({ config, headers: { 'x-webhook-token': 'topsecret' }, rawBody: '' }).ok
    ).toBe(true)
  })

  it('accepts the GitLab X-Gitlab-Token header', () => {
    expect(
      verifyWebhookSecret({ config, headers: { 'x-gitlab-token': 'topsecret' }, rawBody: '' }).ok
    ).toBe(true)
  })

  it('rejects a wrong token', () => {
    const r = verifyWebhookSecret({ config, headers: { 'x-gitlab-token': 'nope' }, rawBody: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('token_mismatch')
  })

  it('rejects a missing token', () => {
    expect(verifyWebhookSecret({ config, headers: {}, rawBody: '' }).ok).toBe(false)
  })
})

describe('verifyWebhookSecret — hmac_sha256', () => {
  const secret = 'hmac-key'
  const config = { enabled: true, secretMode: 'hmac_sha256' as const, secret }
  const body = '{"object_kind":"merge_request"}'
  const digest = createHmac('sha256', secret).update(body).digest('hex')

  it('accepts a GitHub-style sha256= prefixed signature', () => {
    expect(
      verifyWebhookSecret({
        config,
        headers: { 'x-hub-signature-256': `sha256=${digest}` },
        rawBody: body
      }).ok
    ).toBe(true)
  })

  it('accepts a Gitea-style bare hex signature', () => {
    expect(
      verifyWebhookSecret({ config, headers: { 'x-gitea-signature': digest }, rawBody: body }).ok
    ).toBe(true)
  })

  it('rejects a signature over a different body', () => {
    const r = verifyWebhookSecret({
      config,
      headers: { 'x-hub-signature-256': `sha256=${digest}` },
      rawBody: '{"tampered":true}'
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('signature_mismatch')
  })
})

describe('verifyWebhookSecret — misconfigured', () => {
  it('fails closed when a verifying mode has no secret', () => {
    const r = verifyWebhookSecret({
      config: { enabled: true, secretMode: 'token', secret: null },
      headers: { 'x-webhook-token': 'x' },
      rawBody: ''
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_secret_configured')
  })
})
