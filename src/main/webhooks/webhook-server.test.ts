import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  Automation,
  AutomationWebhookConfig,
  AutomationWebhookDelivery
} from '../../shared/automations-types'
import { WebhookServer } from './webhook-server'

type TriggerFn = (automationId: string, delivery: AutomationWebhookDelivery) => Promise<void>

function makeAutomation(webhook: AutomationWebhookConfig | null): Automation {
  return {
    id: 'auto-1',
    name: 'MR review',
    prompt: 'Review the MR',
    precheck: null,
    agentId: 'claude',
    projectId: 'r1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    webhook,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('WebhookServer', () => {
  let server: WebhookServer
  let triggerWebhook: Mock<TriggerFn>
  let automation: Automation | undefined
  let base: string

  beforeEach(async () => {
    triggerWebhook = vi.fn<TriggerFn>().mockResolvedValue(undefined)
    automation = makeAutomation({ enabled: true, secretMode: 'none', secret: null })
    server = new WebhookServer({
      getAutomation: (id) => (id === automation?.id ? automation : undefined),
      triggerWebhook
    })
    await server.start({ enabled: true, bindAddress: '127.0.0.1', port: 0 })
    const endpoint = server.getEndpoint()
    expect(endpoint.running).toBe(true)
    base = `http://127.0.0.1:${endpoint.port}`
  })

  afterEach(() => {
    server.stop()
  })

  it('accepts a valid POST and triggers the automation', async () => {
    const res = await fetch(`${base}/webhook/auto-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"object_kind":"merge_request"}'
    })
    expect(res.status).toBe(202)
    expect(triggerWebhook).toHaveBeenCalledTimes(1)
    const [id, delivery] = triggerWebhook.mock.calls[0]
    expect(id).toBe('auto-1')
    expect(delivery.body).toBe('{"object_kind":"merge_request"}')
    expect(delivery.contentType).toBe('application/json')
  })

  it('rejects non-POST methods with 405', async () => {
    const res = await fetch(`${base}/webhook/auto-1`, { method: 'GET' })
    expect(res.status).toBe(405)
    expect(triggerWebhook).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown automation', async () => {
    const res = await fetch(`${base}/webhook/does-not-exist`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the webhook trigger is disabled', async () => {
    automation = makeAutomation({ enabled: false, secretMode: 'none', secret: null })
    const res = await fetch(`${base}/webhook/auto-1`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(triggerWebhook).not.toHaveBeenCalled()
  })

  it('returns 404 for a non-webhook path', async () => {
    const res = await fetch(`${base}/`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  it('returns 404 for a nested sub-path', async () => {
    const res = await fetch(`${base}/webhook/auto-1/extra`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  it('rejects a request with a bad token (401)', async () => {
    automation = makeAutomation({ enabled: true, secretMode: 'token', secret: 'right' })
    const res = await fetch(`${base}/webhook/auto-1`, {
      method: 'POST',
      headers: { 'x-gitlab-token': 'wrong' },
      body: '{}'
    })
    expect(res.status).toBe(401)
    expect(triggerWebhook).not.toHaveBeenCalled()
  })

  it('accepts a request with the correct token', async () => {
    automation = makeAutomation({ enabled: true, secretMode: 'token', secret: 'right' })
    const res = await fetch(`${base}/webhook/auto-1`, {
      method: 'POST',
      headers: { 'x-gitlab-token': 'right' },
      body: '{}'
    })
    expect(res.status).toBe(202)
    expect(triggerWebhook).toHaveBeenCalledTimes(1)
  })
})

describe('WebhookServer.apply', () => {
  it('does not start when disabled, starts when enabled', async () => {
    const server = new WebhookServer({ getAutomation: () => undefined, triggerWebhook: vi.fn() })
    await server.apply({ enabled: false, bindAddress: '127.0.0.1', port: 0 })
    expect(server.getEndpoint().running).toBe(false)
    await server.apply({ enabled: true, bindAddress: '127.0.0.1', port: 0 })
    expect(server.getEndpoint().running).toBe(true)
    server.stop()
  })

  it('records a bind error without throwing on an invalid bind address', async () => {
    const server = new WebhookServer({ getAutomation: () => undefined, triggerWebhook: vi.fn() })
    await server.start({ enabled: true, bindAddress: '203.0.113.250', port: 0 })
    const endpoint = server.getEndpoint()
    expect(endpoint.running).toBe(false)
    expect(endpoint.error).not.toBeNull()
    server.stop()
  })
})
