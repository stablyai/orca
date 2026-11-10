import { describe, expect, it } from 'vitest'
import type { Translate } from '../i18n/mobile-i18n'
import { CloudRequestError } from './cloud-control-plane-request'
import {
  entitlementDeniedMessage,
  ownerForCloudError,
  roleForCloudError
} from './cloud-entitlement-copy'

// The fallback text with {{vars}} filled in, as i18next does for a missing key.
const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value: unknown = options?.[name]
    return typeof value === 'string' ? value : ''
  })

const denied = (reason: string) => new CloudRequestError('entitlement_denied', 403, reason)

describe('entitlementDeniedMessage', () => {
  it('sends owners and admins to the fix, and members to an owner or admin', () => {
    expect(
      entitlementDeniedMessage(denied('included_hours_exhausted'), 'admin', 'existing', t)
    ).toBe(
      'Out of sandbox hours. Your files are safe. Turn on overage in Orca on your computer, then try again.'
    )
    expect(
      entitlementDeniedMessage(denied('included_hours_exhausted'), 'member', 'existing', t)
    ).toBe('Out of sandbox hours. Your files are safe. Ask an owner or admin to add hours.')
    expect(entitlementDeniedMessage(denied('overage_cap_reached'), 'owner', 'create', t)).toBe(
      'Spend cap reached. Nothing was created, and you weren’t charged. Raise the spend cap in Orca on your computer, then try again.'
    )
    expect(entitlementDeniedMessage(denied('payment_grace_expired'), 'member', 'create', t)).toBe(
      'Payment failed, so new sandboxes can’t start. Nothing was created, and you weren’t charged. Ask an owner or admin to update the payment method.'
    )
  })

  it('gives owners and admins the fix for payment, plan and other denials', () => {
    expect(entitlementDeniedMessage(denied('payment_past_due'), 'admin', 'existing', t)).toBe(
      'Payment failed, so new sandboxes can’t start. Your files are safe. Update the payment method in Orca on your computer.'
    )
    expect(entitlementDeniedMessage(denied('subscription_inactive'), 'owner', 'create', t)).toBe(
      'Orca Cloud needs a Team plan. Nothing was created, and you weren’t charged. Choose a plan in Orca on your computer.'
    )
    expect(entitlementDeniedMessage(denied('something_new'), 'admin', 'existing', t)).toBe(
      'Your team’s plan doesn’t allow this right now. Your files are safe. Check billing in Orca on your computer.'
    )
  })

  it('uses member copy when the role is unknown, and the same next step for limits whatever the role', () => {
    expect(entitlementDeniedMessage(denied('no_subscription'), null, 'create', t)).toContain(
      'Ask an owner or admin to choose a plan.'
    )
    expect(entitlementDeniedMessage(denied('concurrency_limit'), 'admin', 'create', t)).toBe(
      'Your team is at its limit of running sandboxes (3 per seat). Nothing was created, and you weren’t charged. Put one to sleep or delete it, then try again.'
    )
    expect(
      entitlementDeniedMessage(denied('member_concurrency_limit'), 'member', 'existing', t)
    ).toBe(
      'This workspace’s owner is at their limit of running sandboxes. Your files are safe. Ask the owner to put one to sleep, or if it’s your workspace, put one to sleep or delete it, then try again.'
    )
    expect(
      entitlementDeniedMessage(denied('member_concurrency_limit'), 'member', 'create', t)
    ).toBe(
      'You’re at your limit of running sandboxes. Nothing was created, and you weren’t charged. Put one to sleep or delete it, then try again.'
    )
  })
})

describe('per-seat limit on an existing workspace', () => {
  it('names the teammate whose seat is full, speaks to the owner directly, and hedges only when unknown', () => {
    const error = denied('member_concurrency_limit')
    expect(
      entitlementDeniedMessage(error, 'member', 'existing', t, { self: false, name: 'Alex' })
    ).toBe(
      'Alex is at their limit of running sandboxes, and this workspace runs on their seat. Your files are safe. Ask them to put one to sleep, then try again.'
    )
    expect(
      entitlementDeniedMessage(error, 'member', 'existing', t, { self: false, name: null })
    ).toMatch(
      /^The workspace owner is at their limit of running sandboxes, and this workspace runs on their seat\. Your files are safe\. Ask them to put one to sleep, then try again\.$/
    )
    expect(
      entitlementDeniedMessage(error, 'owner', 'existing', t, { self: true, name: 'Me' })
    ).toBe(
      'You’re at your limit of running sandboxes. Your files are safe. Put one to sleep or delete it, then try again.'
    )
    expect(entitlementDeniedMessage(error, 'member', 'existing', t, null)).toBe(
      'This workspace’s owner is at their limit of running sandboxes. Your files are safe. Ask the owner to put one to sleep, or if it’s your workspace, put one to sleep or delete it, then try again.'
    )
  })
})

describe('ownerForCloudError', () => {
  const plane = (body: unknown, status = 200) => {
    const paths: string[] = []
    return {
      paths,
      plane: {
        baseUrl: 'https://cp.test',
        token: () => 'tok',
        fetch: async (url: string | URL | Request) => {
          paths.push(new URL(String(url)).pathname)
          return new Response(JSON.stringify(body), { status })
        }
      }
    }
  }
  const row = (access: string, names: Record<string, string> | undefined) => ({
    workspace: {
      id: 'sbx_1',
      workspaceId: 'ws_1',
      status: 'suspended',
      machineSize: 'standard',
      region: 'iad1',
      createdAt: 1,
      title: 'Fix login',
      repo: null,
      visibility: 'team',
      section: null,
      archivedAt: null,
      createdBy: 'usr_alex',
      ownerUserId: 'usr_alex',
      lastActivityAt: 1,
      lastActivityBy: null,
      cost: {
        computeMs: 0,
        rateUsdMicrosPerHour: 0,
        computeUsdMicros: 0,
        tokenUsdMicros: null,
        totalUsdMicros: 0
      },
      access,
      presence: [],
      memberNames: names
    }
  })

  it('reads the owner from the team registry only for a per-seat limit', async () => {
    const teammate = plane(row('can_open', { usr_alex: 'Alex' }))
    await expect(
      ownerForCloudError(denied('member_concurrency_limit'), teammate.plane, 'sbx_1')
    ).resolves.toEqual({ self: false, name: 'Alex' })
    expect(teammate.paths).toEqual(['/v1/team/workspaces/sbx_1'])

    const mine = plane(row('owner', undefined))
    await expect(
      ownerForCloudError(denied('member_concurrency_limit'), mine.plane, 'sbx_1')
    ).resolves.toEqual({ self: true, name: null })

    const other = plane(row('can_open', {}))
    await expect(
      ownerForCloudError(denied('concurrency_limit'), other.plane, 'sbx_1')
    ).resolves.toBe(null)
    expect(other.paths).toEqual([])
  })

  it('falls back to null (generic copy) when the registry cannot answer', async () => {
    const failing = plane({ error: 'not_found' }, 404)
    await expect(
      ownerForCloudError(denied('member_concurrency_limit'), failing.plane, 'sbx_1')
    ).resolves.toBeNull()
  })
})

describe('roleForCloudError', () => {
  it('reads the role only for a plan denial, and falls back to null when it cannot', async () => {
    let calls = 0
    const plane = {
      baseUrl: 'https://cp.test',
      token: () => 'tok',
      fetch: async () => {
        calls++
        return new Response(JSON.stringify({ role: 'admin' }), { status: 200 })
      }
    }
    expect(await roleForCloudError(new CloudRequestError('network_error', 0), plane)).toBeNull()
    expect(calls).toBe(0)
    expect(await roleForCloudError(denied('included_hours_exhausted'), plane)).toBe('admin')
    const broken = {
      ...plane,
      fetch: async () => new Response('', { status: 500 })
    }
    expect(await roleForCloudError(denied('included_hours_exhausted'), broken)).toBeNull()
  })
})
