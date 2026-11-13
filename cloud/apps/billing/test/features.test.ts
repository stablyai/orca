// Enterprise feature entitlements (audit_log, sso, scim, mfa_enforcement): the catalog version
// that carries them, how a team gets them, and the internal route services gate on.
import { describe, expect, it } from 'vitest'
import { loadCatalog, parseCatalogFile } from '../src/catalog'
import { FEATURE_KEYS, parseEntitlementValue } from '../src/entitlement-keys'
import { featuresFor } from '../src/features'
import { grantContactSalesPlan, grantsForSource, revokeManualGrant } from '../src/grants'
import { repoCatalog } from './catalog-fixture'
import { createHarness } from './harness'

const ALL_OFF = { audit_log: false, sso: false, scim: false, mfa_enforcement: false }
const ALL_ON = { audit_log: true, sso: true, scim: true, mfa_enforcement: true }
const SOURCE = 'plan:enterprise:ticket-1'

async function enterprise(h: Awaited<ReturnType<typeof createHarness>>, accountId = 'org:o1', endsAt: number | null = null) {
  const now = Date.now()
  const catalog = await loadCatalog(h.env.BILLING_DB, now)
  return grantContactSalesPlan(h.env.BILLING_DB, catalog, { subjectId: accountId, planId: 'enterprise', sourceId: SOURCE, startsAt: now - 1000, endsAt, actor: 'ops:test', now })
}

const features = (h: Awaited<ReturnType<typeof createHarness>>, accountId = 'org:o1') => h.controlPlane('/v1/internal/entitlements/features', { accountId })

describe('catalog', () => {
  it('puts every Enterprise feature on Enterprise v2 and on no other plan; v1 is unchanged', () => {
    const file = parseCatalogFile(repoCatalog())
    const plan = file.plans.find((entry) => entry.id === 'enterprise')!
    expect(plan.currentVersion).toBe(2)
    expect(plan.versions.find((entry) => entry.version === 1)!.entitlements).toEqual({})
    const v2 = plan.versions.find((entry) => entry.version === 2)!
    expect(v2.entitlements).toEqual(Object.fromEntries(FEATURE_KEYS.map((key) => [key, { value: true }])))
    expect(v2.features.map((feature) => feature.id)).toContain('audit_log')
    for (const other of file.plans.filter((entry) => entry.id !== 'enterprise')) {
      for (const version of other.versions) {
        for (const key of FEATURE_KEYS) {
          expect(version.entitlements[key], `${other.id} v${version.version} ${key}`).toBeUndefined()
        }
      }
    }
  })

  it('a feature is a boolean and never per seat', () => {
    for (const key of FEATURE_KEYS) {
      expect(parseEntitlementValue(key, { value: true })).toEqual({ value: true, perSeat: false })
      expect(() => parseEntitlementValue(key, { value: 1 })).toThrow(/invalid value/)
      expect(() => parseEntitlementValue(key, { value: true, perSeat: true })).toThrow(/cannot be per seat/)
    }
  })
})

describe.each(['shadow', 'on'])('features (ENTITLEMENTS_MODE=%s)', (mode) => {
  it('are off for a team without Enterprise and on for one granted the plan', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: mode })
    expect((await features(h)).body).toEqual({ features: ALL_OFF })
    expect(await enterprise(h)).toEqual({ changed: true, planVersion: 2 })
    expect((await features(h)).body).toEqual({ features: ALL_ON })
    // Another team is unaffected.
    expect((await features(h, 'org:o2')).body).toEqual({ features: ALL_OFF })
  })

  it('the grant names the real plan and version, and stops when it ends or is revoked', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: mode })
    const now = Date.now()
    await enterprise(h, 'org:o1', now + 3600_000)
    const rows = await grantsForSource(h.env.BILLING_DB, 'manual', SOURCE)
    expect(rows.map((row) => row.entitlement_key).sort()).toEqual([...FEATURE_KEYS].sort())
    expect(rows.every((row) => row.plan_id === 'enterprise' && row.plan_version === 2 && row.state === 'active')).toBe(true)
    expect(await featuresFor(h.env, 'org:o1', now)).toEqual(ALL_ON)
    expect(await featuresFor(h.env, 'org:o1', now + 3600_000)).toEqual(ALL_OFF)
    await revokeManualGrant(h.env.BILLING_DB, { subjectId: 'org:o1', source: 'manual', sourceId: SOURCE, reason: 'contract_ended', actor: 'ops:test', now })
    expect(await featuresFor(h.env, 'org:o1', now)).toEqual(ALL_OFF)
  })
})

describe('features', () => {
  it('are all off when ENTITLEMENTS_MODE is off, whatever grants exist', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'shadow' })
    await enterprise(h)
    h.env.ENTITLEMENTS_MODE = 'off'
    expect((await features(h)).body).toEqual({ features: ALL_OFF })
  })

  it('only a contact-sales plan can be granted this way', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const now = Date.now()
    const catalog = await loadCatalog(h.env.BILLING_DB, now)
    await expect(
      grantContactSalesPlan(h.env.BILLING_DB, catalog, { subjectId: 'org:o1', planId: 'team', sourceId: 'plan:team:x', startsAt: now, endsAt: null, actor: 'ops', now })
    ).rejects.toThrow(/not_a_contact_sales_plan/)
  })

  it('the route takes the control plane or auth token and nothing else', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on', MEMBERSHIP_SYNC_TOKEN: 'm'.repeat(40) })
    expect((await features(h)).status).toBe(200)
    expect((await h.controlPlane('/v1/internal/entitlements/features', { accountId: 'org:o1' }, 'm'.repeat(40))).status).toBe(200)
    expect((await h.controlPlane('/v1/internal/entitlements/features', { accountId: 'org:o1' }, 'x'.repeat(40))).status).toBe(401)
    const desktop = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    expect((await h.controlPlane('/v1/internal/entitlements/features', { accountId: 'org:o1' }, desktop)).status).toBe(401)
    expect((await h.controlPlane('/v1/internal/entitlements/features', { accountId: 'org:o1', extra: 1 })).status).toBe(400)
    expect((await h.controlPlane('/v1/internal/entitlements/features', {})).status).toBe(400)
  })

  it('never change the start check or the entitlement object (no shadow diff)', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'shadow' })
    const check = () => h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })
    const before = (await check()).body
    await enterprise(h)
    const after = (await check()).body
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).not.toMatch(/audit_log|auditLog|mfa_enforcement/)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM entitlement_shadow_diffs').get()).toEqual({ n: 0 })
  })

  it('show on GET /v1/entitlements for the desktop', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const read = () => h.call('GET', '/v1/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect((await read()).body.effective.features).toEqual(ALL_OFF)
    await enterprise(h)
    const body = (await read()).body
    expect(body.effective.features).toEqual(ALL_ON)
    expect(body.grants.find((grant: { key: string }) => grant.key === 'audit_log')).toMatchObject({ value: true, source: 'manual', plan: { id: 'enterprise', version: 2 }, state: 'active' })
  })
})
