import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { SigningGates } from './signing-gates.js'
import type { SigningConfig } from './config.js'

const config: SigningConfig = {
  repository: 'stablyai/orca',
  appId: '12',
  installationId: 34,
  privateKey: 'unused',
  githubWebhookSecret: 'github-secret'.repeat(4),
  signpathWebhookSecret: 'signpath-secret'.repeat(4),
  reconcileSecret: 'reconcile-secret'.repeat(4),
  signpathToken: 'unused',
  signpathOrganization: '11111111-1111-4111-8111-111111111111',
  signpathProject: 'orca',
  policies: []
}
function fixture() {
  const gates = new SigningGates(config, {
    github: vi.fn(),
    signpath: vi.fn()
  })
  const processRun = vi.spyOn(gates, 'processRun').mockResolvedValue()
  const processSignpath = vi.spyOn(gates, 'processSignpath').mockResolvedValue()
  const reconcile = vi.spyOn(gates, 'reconcile').mockResolvedValue()
  return {
    app: createApp(config, gates),
    processRun,
    processSignpath,
    reconcile
  }
}
const event = {
  action: 'requested',
  environment: 'windows-inner-signing',
  deployment_callback_url:
    'https://api.github.com/repos/stablyai/orca/actions/runs/42/deployment_protection_rule',
  repository: { full_name: String(config.repository) },
  installation: { id: 34 }
}
function signed(body: string) {
  return {
    'x-github-event': 'deployment_protection_rule',
    'x-hub-signature-256': `sha256=${createHmac('sha256', config.githubWebhookSecret).update(body).digest('hex')}`
  }
}
describe('webhook authentication', () => {
  it('validates the exact raw GitHub request', async () => {
    const f = fixture()
    const body = JSON.stringify(event)
    expect(
      (
        await f.app.request('/webhooks/github', {
          method: 'POST',
          body,
          headers: signed(body)
        })
      ).status
    ).toBe(200)
    expect(f.processRun).toHaveBeenCalledWith(42, 'windows-inner-signing')
    f.processRun.mockClear()
    expect(
      (
        await f.app.request('/webhooks/github', {
          method: 'POST',
          body: body + ' ',
          headers: signed(body)
        })
      ).status
    ).toBe(401)
    expect(f.processRun).not.toHaveBeenCalled()
  })
  it.each(['repository', 'installation', 'callback'])(
    'rejects correctly signed wrong %s',
    async (mismatch) => {
      const f = fixture()
      const payload = structuredClone(event)
      if (mismatch === 'repository') payload.repository.full_name = 'evil/orca'
      if (mismatch === 'installation') payload.installation.id = 99
      if (mismatch === 'callback')
        payload.deployment_callback_url = 'https://evil.example/42/deployment_protection_rule'
      const body = JSON.stringify(payload)
      expect(
        (
          await f.app.request('/webhooks/github', {
            method: 'POST',
            body,
            headers: signed(body)
          })
        ).status
      ).toBe(400)
      expect(f.processRun).not.toHaveBeenCalled()
    }
  )
  it('returns 400 for authenticated malformed JSON', async () => {
    const f = fixture()
    const body = '{'
    expect(
      (
        await f.app.request('/webhooks/github', {
          method: 'POST',
          body,
          headers: signed(body)
        })
      ).status
    ).toBe(400)
    expect(
      (
        await f.app.request('/webhooks/signpath', {
          method: 'POST',
          body,
          headers: { authorization: `Bearer ${config.signpathWebhookSecret}` }
        })
      ).status
    ).toBe(400)
  })
  it('uses default SignPath body and a distinct bearer secret', async () => {
    const f = fixture()
    const requestId = '22222222-2222-4222-8222-222222222222'
    const body = JSON.stringify({
      OrganizationId: config.signpathOrganization,
      SigningRequestId: requestId,
      Status: 'Completed'
    })
    for (const secret of ['', config.githubWebhookSecret, config.reconcileSecret]) {
      expect(
        (
          await f.app.request('/webhooks/signpath', {
            method: 'POST',
            body,
            headers: { authorization: `Bearer ${secret}` }
          })
        ).status
      ).toBe(401)
    }
    expect(f.processSignpath).not.toHaveBeenCalled()
    expect(
      (
        await f.app.request('/webhooks/signpath', {
          method: 'POST',
          body,
          headers: { authorization: `Bearer ${config.signpathWebhookSecret}` }
        })
      ).status
    ).toBe(200)
    expect(f.processSignpath).toHaveBeenCalledWith(requestId)
  })
  it('requires the dedicated reconciliation secret', async () => {
    const f = fixture()
    expect(
      (
        await f.app.request('/reconcile', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.signpathWebhookSecret}` }
        })
      ).status
    ).toBe(401)
    expect(f.reconcile).not.toHaveBeenCalled()
    expect(
      (
        await f.app.request('/reconcile', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.reconcileSecret}` }
        })
      ).status
    ).toBe(200)
    expect(f.reconcile).toHaveBeenCalledTimes(1)
  })
  it('bounds unauthenticated request bodies', async () => {
    const f = fixture()
    expect(
      (
        await f.app.request('/webhooks/github', {
          method: 'POST',
          body: 'x'.repeat(256 * 1024 + 1)
        })
      ).status
    ).toBe(413)
    expect(f.processRun).not.toHaveBeenCalled()
  })
})
