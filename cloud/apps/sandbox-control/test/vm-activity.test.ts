import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { ACTIVITY_SCRIPT, decideFromActivity, type VmActivity } from '../src/vm-activity'
import { createHarness } from './harness'

const MIN = 60_000
const NOW = 1_800_000_000_000

function activity(overrides: Partial<VmActivity> = {}, verdict: Partial<NonNullable<VmActivity['verdict']>> | null = {}): VmActivity {
  return {
    cpuPercent: 2,
    orcadAlive: true,
    nowMs: NOW,
    verdict: verdict === null ? null : { verdict: 'idle', idleSince: NOW - MIN, lastPtyInputAt: null, at: NOW - 30_000, ...verdict },
    ...overrides
  }
}

describe('decideFromActivity', () => {
  it('renews while an agent works, a user typed recently, or the CPU is busy', () => {
    expect(decideFromActivity(activity({}, { verdict: 'busy', idleSince: null }))).toBe('renew')
    expect(decideFromActivity(activity({}, { verdict: 'unverifiable', idleSince: null }))).toBe('renew')
    expect(decideFromActivity(activity({}, { lastPtyInputAt: NOW - 5 * MIN, idleSince: NOW - 60 * MIN }))).toBe('renew')
    expect(decideFromActivity(activity({ cpuPercent: 90 }, null))).toBe('renew')
  })

  it('sleeps only after the idle-sleep window, and waits before it', () => {
    expect(decideFromActivity(activity({}, { idleSince: NOW - 16 * MIN }))).toBe('sleep')
    expect(decideFromActivity(activity({}, { idleSince: NOW - 5 * MIN }))).toBe('wait')
  })

  it('lets the lease lapse with no orcad, no answer, or a stale verdict and a quiet CPU', () => {
    expect(decideFromActivity(null)).toBe('lapse')
    expect(decideFromActivity(activity({ orcadAlive: false }))).toBe('lapse')
    expect(decideFromActivity(activity({}, { verdict: 'busy', at: NOW - 30 * MIN }))).toBe('lapse')
    expect(decideFromActivity(activity({}, null))).toBe('lapse')
  })
})

describe('cron keep-alive with no desktop', () => {
  async function setup(answer: () => VmActivity) {
    const h = await createHarness()
    h.vercel.commandHandler = (params) =>
      params.command === 'bash' && params.args?.[1] === ACTIVITY_SCRIPT
        ? { exitCode: 0, stdout: `${JSON.stringify({ ...answer(), nowMs: h.now() })}\n`, stderr: '' }
        : undefined
    const { sandbox } = HostedSandboxReadyResponseSchema.parse((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ka', machineSize: 'standard' } })).body)
    return { h, sandbox }
  }

  it('keeps a sandbox with a busy agent running past 35 minutes without any lease call', async () => {
    const { h, sandbox } = await setup(() => activity({}, { verdict: 'busy', idleSince: null, at: h.now() }))
    for (let minute = 5; minute <= 60; minute += 5) {
      h.advance(5 * MIN)
      await h.reconcile()
    }
    const view = (await h.call('GET', `/v1/sandboxes/${sandbox.id}`)).body.sandbox
    expect(view.status).toBe('running')
    expect(view.session.leaseExpiresAt).toBeGreaterThan(h.now())
  })

  it('puts an idle sandbox to sleep once it has been idle for the idle-sleep window', async () => {
    let idleSince = 0
    const { h, sandbox } = await setup(() => activity({}, { verdict: 'idle', idleSince, at: h.now() }))
    idleSince = h.now()
    let slept = 0
    for (let minute = 5; minute <= 30 && slept === 0; minute += 5) {
      h.advance(5 * MIN)
      slept = (await h.reconcile()).idleSlept
    }
    expect(slept).toBe(1)
    expect((await h.call('GET', `/v1/sandboxes/${sandbox.id}`)).body.sandbox.status).toBe('suspended')
  })
})
