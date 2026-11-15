// Dev-only redacted provider-policy audit and the A4 scrub primitive (egress-docs probe 2).
import { describe, expect, it } from 'vitest'
import { policyFacts } from '../src/operator'
import { createHarness } from './harness'

const OP = 'o'.repeat(40)
const MARKER = 'orcaprobebogus-0123456789'

async function setup(env: Record<string, string>) {
  const h = await createHarness({
    SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'),
    EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy',
    SECRETS_EGRESS_PLACEHOLDERS: 'on',
    OPERATOR_TOKEN: OP,
    EGRESS_SWAP_MODE: 'firewall',
    ...env
  })
  const mia = await h.token('mia', 'acme', 'sandbox', {})
  await h.call('PUT', '/v1/secrets/personal/ANTHROPIC_API_KEY', { body: { value: `sk-ant-api03-${MARKER}` }, bearer: mia })
  const created = await h.call('POST', '/v1/sandboxes', { bearer: mia, body: { workspaceId: 'ws-1', machineSize: 'standard' } })
  const id: string = created.body.sandbox.id
  const box = () => [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === id)!
  return { h, id, box }
}

describe('provider-policy-audit (dev only)', () => {
  it('answers redacted facts: the marker is found, but no value or body comes back', async () => {
    const { h, id } = await setup({ SANDBOX_ENV: 'dev' })
    const res = await h.call('GET', `/v1/internal/sandboxes/${id}/provider-policy-audit?marker=${MARKER}`, { bearer: OP })
    expect(res.status).toBe(200)
    expect(res.body.session.markerFound).toBe(true)
    expect(res.body.session.hasNetworkPolicy).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain(MARKER)
    expect(JSON.stringify(res.body)).not.toContain('sk-ant')
  })

  it('refuses a short or foreign marker, and does not exist outside dev', async () => {
    const dev = await setup({ SANDBOX_ENV: 'dev' })
    expect((await dev.h.call('GET', `/v1/internal/sandboxes/${dev.id}/provider-policy-audit?marker=sk-ant`, { bearer: OP })).status).toBe(400)
    const prod = await setup({ SANDBOX_ENV: 'prod' })
    expect((await prod.h.call('GET', `/v1/internal/sandboxes/${prod.id}/provider-policy-audit?marker=${MARKER}`, { bearer: OP })).status).toBe(404)
  })

  it('scrub-test writes the token-free compile to the record: routes kept, no value', async () => {
    const { h, id, box } = await setup({ SANDBOX_ENV: 'dev' })
    expect(JSON.stringify(box().policy)).toContain(MARKER)
    const res = await h.call('POST', `/v1/internal/sandboxes/${id}/provider-policy-scrub-test`, { bearer: OP })
    expect(res.body.outcome).toBe('scrubbed')
    const record = JSON.stringify(box().recordPolicy)
    expect(record).not.toContain(MARKER)
    expect(record).toContain('api.anthropic.com')
  })
})

describe('policyFacts', () => {
  it('counts injection, forward and response rules separately, with header names per kind only', () => {
    const live = JSON.stringify({ session: { networkPolicy: { injectionRules: [{ domain: 'a.com', headerNames: ['Authorization', 'x-api-key'] }], forwardRules: [{ domain: 'b.com', headerNames: ['bad header'] }], responseRules: [{ domain: 'a.com', statusCode: 403 }] } } })
    expect(policyFacts(live, MARKER)).toEqual({
      hasNetworkPolicy: true,
      injectionRules: { count: 1, headerNames: ['authorization', 'x-api-key'] },
      forwardRules: { count: 1, headerNames: [] },
      responseRules: { count: 1, headerNames: [] },
      markerFound: false
    })
    // A scrubbed policy reads as no injection rules, response rules only.
    const scrubbed = JSON.stringify({ session: { networkPolicy: { responseRules: [{ domain: 'a.com', statusCode: 403 }, { domain: 'a.com', statusCode: 403 }] } } })
    expect(policyFacts(scrubbed, MARKER)).toMatchObject({ injectionRules: { count: 0 }, responseRules: { count: 2 } })
  })
})

describe('resume-raw and echo-probe (dev only)', () => {
  it('echo-probe answers only whether the marker came back; placeholders only', async () => {
    const { h, id } = await setup({ SANDBOX_ENV: 'dev' })
    h.vercel.commandHandler = (params) =>
      params.command === 'bash' && params.args?.[1]?.includes('orca-echo-probe') ? { exitCode: 0, stdout: '200\n1\n', stderr: '' } : undefined
    const placeholder = `orca-ph-anthropic-api-key-${id}`
    const ok = await h.call('POST', `/v1/internal/sandboxes/${id}/echo-probe?marker=${MARKER}`, { bearer: OP, body: { host: 'httpbin.org', header: 'x-api-key', placeholder } })
    expect(ok.body).toEqual({ sandboxId: id, status: 200, markerFound: true })
    const value = await h.call('POST', `/v1/internal/sandboxes/${id}/echo-probe?marker=${MARKER}`, { bearer: OP, body: { host: 'httpbin.org', header: 'x-api-key', placeholder: 'sk-ant-real' } })
    expect(value.status).toBe(400)
    const elsewhere = await h.call('POST', `/v1/internal/sandboxes/${id}/echo-probe?marker=${MARKER}`, { bearer: OP, body: { host: 'evil.example', header: 'x-api-key', placeholder } })
    expect(elsewhere.status).toBe(400)
  })

  it('resume-raw resumes the provider session without writing a policy', async () => {
    const { h, id, box } = await setup({ SANDBOX_ENV: 'dev' })
    const mia = await h.token('mia', 'acme', 'sandbox', {})
    expect((await h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: mia })).status).toBe(200)
    const before = JSON.stringify(box().policy)
    const res = await h.call('POST', `/v1/internal/sandboxes/${id}/resume-raw`, { bearer: OP })
    expect(res.body.sandboxId).toBe(id)
    expect(JSON.stringify(box().policy)).toBe(before)
  })
})
