// The upgrade's forward to the host's object, through the Worker's router with stub objects and
// no workerd: a forward that throws is answered 503 + Retry-After, never thrown.
import { exportJWK, generateKeyPair } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_WAKE_PATH } from '../../../packages/connector-contract/src/wake-messages'
import type { Env } from '../src/env'
import { mintWake, newHost } from './harness'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
const { default: worker } = await import('../src/index')

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
const JWKS = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256' }] })

function harness(fetch: (request: Request) => Promise<Response>) {
  const metrics: string[] = []
  const env = {
    WAKE_JWKS: JWKS,
    WAKE_ADMIN_KEY: 'k'.repeat(40),
    WAKE_ADMIN_ISSUER: 'https://connector.test.invalid',
    CONNECTOR_HOST: { idFromName: (name: string) => name, get: () => ({ fetch }) },
    METRICS: { writeDataPoint: (point: { blobs: string[] }) => metrics.push(`${point.blobs[0]}:${point.blobs[1]}`) }
  } as unknown as Env
  return { env, metrics }
}

async function upgrade(env: Env): Promise<Response> {
  const token = await mintWake(privateKey, newHost())
  const request = new Request(`https://wake.test${CONNECTOR_WAKE_PATH}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${token}` } })
  return worker.fetch(request, env, {} as ExecutionContext)
}

describe('upgrade forward', () => {
  afterEach(() => vi.restoreAllMocks())

  it('answers 503 with a 5-30 s Retry-After when the object stub throws, and logs no ids', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env, metrics } = harness(async () => {
      throw Object.assign(new Error('internal error; reference = abc'), { retryable: true })
    })
    const response = await upgrade(env)
    expect(response.status).toBe(503)
    const retryAfter = Number(response.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(5)
    expect(retryAfter).toBeLessThanOrEqual(30)
    expect(metrics).toEqual(['upgrade:object_unavailable'])
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]).toEqual(['connector-wake: object forward failed', { message: 'internal error; reference = abc', retryable: true, overloaded: false, place: 'local' }])
  })

  it('passes the object answer through unchanged when the stub answers', async () => {
    const seen: Request[] = []
    const { env, metrics } = harness(async (request) => {
      seen.push(request)
      return new Response(null, { status: 204 })
    })
    const response = await upgrade(env)
    expect(response.status).toBe(204)
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.get('authorization')).toBeNull()
    expect(metrics).toEqual([])
  })

  it('still throws (and logs) what is not a forward failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env } = harness(async () => new Response(null, { status: 204 }))
    const broken = { ...env, WAKE_ADMIN_KEY: 'short' } as Env
    await expect(upgrade(broken)).rejects.toThrow('connector_wake_config_admin')
    expect(error.mock.calls[0]?.[0]).toBe('connector-wake: request threw')
    expect(error.mock.calls[0]?.[1]).toMatchObject({ route: CONNECTOR_WAKE_PATH })
  })

  it('logs an unknown path as "other", never the path itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env } = harness(async () => new Response(null, { status: 204 }))
    const broken = { ...env, WAKE_ADMIN_KEY: 'short' } as Env
    await expect(worker.fetch(new Request('https://wake.test/__spike/object/acct-123:machine-456'), broken, {} as ExecutionContext)).rejects.toThrow()
    expect(error.mock.calls[0]?.[1]).toMatchObject({ route: 'other' })
    expect(JSON.stringify(error.mock.calls)).not.toContain('acct-123')
  })
})
