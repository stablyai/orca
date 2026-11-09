import { describe, expect, it, vi } from 'vitest'
import type { HostedEnvironmentReady } from './hosted-environment-provider'
import { autoResumeAgentsAfterRollover } from './hosted-agent-auto-resume'
import { createHostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { createHostedSandboxDriver, HOSTED_SANDBOX_CAPABILITIES } from './hosted-sandbox-driver'
import { decideHostedLeaseAction, type HostedActivitySample } from './hosted-session-lease-policy'
import { HostedSessionLeaseScheduler } from './hosted-session-lease-scheduler'
import { createFakeHostedControlPlane } from './fake-hosted-control-plane.test-support'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_800_000_000_000
const session = {
  startedAt: T0,
  deadlineAt: T0 + 23 * HOUR + 50 * MIN,
  leaseExpiresAt: T0 + 30 * MIN
}
const busy: HostedActivitySample = { verdict: 'busy', idleSince: null, lastPtyInputAt: null }
const idleSince = (at: number): HostedActivitySample => ({
  verdict: 'idle',
  idleSince: at,
  lastPtyInputAt: null
})

function decide(now: number, activity: HostedActivitySample, warned: (60 | 15)[] = []) {
  return decideHostedLeaseAction({
    now,
    capabilities: HOSTED_SANDBOX_CAPABILITIES,
    session,
    activity,
    warned: new Set(warned)
  })
}

describe('hosted session lease policy', () => {
  it('renews the lease while work runs and leaves it alone with time to spare', () => {
    expect(decide(T0 + 5 * MIN, busy)).toEqual({ kind: 'none' })
    expect(decide(T0 + 21 * MIN, busy)).toEqual({ kind: 'renew', extendMs: 30 * MIN })
  })

  it('suspends after 20 quiet minutes, but not while a PTY was just typed in', () => {
    expect(decide(T0 + 25 * MIN, idleSince(T0 + 4 * MIN))).toEqual({ kind: 'idle-suspend' })
    const typing = { ...idleSince(T0 + 4 * MIN), lastPtyInputAt: T0 + 24 * MIN }
    expect(decide(T0 + 25 * MIN, typing)).toEqual({ kind: 'renew', extendMs: 30 * MIN })
  })

  it('rolls over quietly after 12h only when nothing is running', () => {
    const at = T0 + 12 * HOUR + MIN
    expect(decide(at, idleSince(at - MIN))).toEqual({ kind: 'rollover', reason: 'opportunistic' })
    expect(decide(at, busy).kind).not.toBe('rollover')
  })

  it('warns at one hour and 15 minutes, then forces the rollover at the deadline', () => {
    expect(decide(session.deadlineAt - 59 * MIN, busy)).toEqual({ kind: 'warn', minutesLeft: 60 })
    expect(decide(session.deadlineAt - 59 * MIN, busy, [60]).kind).not.toBe('warn')
    expect(decide(session.deadlineAt - 14 * MIN, busy, [60])).toEqual({
      kind: 'warn',
      minutesLeft: 15
    })
    expect(decide(session.deadlineAt, busy)).toEqual({ kind: 'rollover', reason: 'forced' })
    expect(decide(session.deadlineAt, idleSince(session.deadlineAt - 3 * MIN))).toEqual({
      kind: 'idle-suspend'
    })
  })
})

describe('hosted session lease scheduler', () => {
  it('rolls a busy session over at the deadline, re-pairs, then continues the drained agents', async () => {
    let now = T0
    const plane = createFakeHostedControlPlane({ now: () => now })
    const driver = createHostedSandboxDriver(
      createHostedSandboxControlPlaneClient({
        baseUrl: 'https://sandbox.cloud.test',
        getAccessToken: async () => plane.token,
        fetch: plane.fetch
      })
    )
    const created = await driver.create({ workspaceId: 'ws-1' })
    const reconnect = vi.fn(async (_ready: HostedEnvironmentReady) => {})
    const resumeAgents = vi.fn(async () => ({
      offered: 2,
      continued: 2,
      skipped: 0,
      unsupported: false
    }))
    const scheduler = new HostedSessionLeaseScheduler({
      driver,
      handle: created.handle,
      session: created.session,
      readActivity: async () => busy,
      warn: () => {},
      reconnect,
      resumeAgents,
      onSuspended: () => {},
      now: () => now
    })
    now = created.session.deadlineAt!
    expect(await scheduler.tick()).toEqual({ kind: 'rollover', reason: 'forced' })
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(reconnect.mock.calls[0]?.[0].session.startedAt).toBe(now)
    expect(resumeAgents).toHaveBeenCalledWith(created.session.deadlineAt)
    // The new session is far from its cap, so the next tick does nothing drastic.
    expect((await scheduler.tick()).kind).not.toBe('rollover')
  })
})

describe('agent auto-resume after rollover', () => {
  it('continues only the offers this drain recorded, through the host restart-offer RPCs', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = []
    const outcome = await autoResumeAgentsAfterRollover(async (method, params) => {
      calls.push({ method, params })
      if (method === 'agentSession.restartResumable') {
        return {
          sessions: [
            { sessionId: 'old', recordedAt: 900 },
            { sessionId: 'a', recordedAt: 1000 },
            { sessionId: 'b', recordedAt: 1500 }
          ]
        }
      }
      return { continued: [{ sessionId: 'a' }], skipped: ['b'] }
    }, 1000)
    expect(calls).toEqual([
      { method: 'agentSession.restartResumable', params: undefined },
      { method: 'agentSession.restartContinue', params: { sessionIds: ['a', 'b'] } }
    ])
    expect(outcome).toEqual({ offered: 2, continued: 1, skipped: 1, unsupported: false })
  })

  it('sends nothing to a host without restart offers', async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'method_not_found' })
    })
    expect(await autoResumeAgentsAfterRollover(call, 0)).toEqual({
      offered: 0,
      continued: 0,
      skipped: 0,
      unsupported: true
    })
    expect(call).toHaveBeenCalledTimes(1)
  })
})
