// The plan catalog as data: plans + immutable plan versions (entitlements, features, policy) in D1,
// applied from catalog/catalog.json by scripts/catalog-apply.ts, and Stripe Price mirrors
// (plan_prices). Nothing here holds a price or an hour count: those are catalog data or Stripe's.
import { z } from 'zod'
import { parseEntitlementValue, type EntitlementKey } from './entitlement-keys'

export const PLAN_KINDS = ['self_serve', 'contact_sales', 'trial', 'free'] as const
export type PlanKind = (typeof PLAN_KINDS)[number]

const PlanIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)
const LookupKey = z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/)

export const PolicySchema = z
  .object({
    // After a failed payment: new starts stop at once; running sandboxes are suspended after this.
    paymentGraceHours: z.number().nonnegative().max(24 * 60),
    // Seats only come down to the member count this close to renewal (never mid-period).
    seatTrueDownHours: z.number().positive().max(24 * 31),
    // Included-hours usage levels (percent) owners and admins are warned at.
    warnAtPercent: z.array(z.number().int().min(1).max(100)).max(4),
    overage: z
      .object({
        defaultSpendCapCents: z.number().int().nonnegative(),
        maxSpendCapCents: z.number().int().positive()
      })
      .strict(),
    seats: z.object({ min: z.number().int().min(1), max: z.number().int().min(1).max(100_000) }).strict()
  })
  .strict()
export type PlanPolicy = z.infer<typeof PolicySchema>

const FeatureSchema = z
  .object({
    // Stable id the desktop localizes; `text` is the English fallback for ids it doesn't know.
    id: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
    params: z.record(z.string(), z.union([z.string().max(100), z.number()])).default({}),
    text: z.string().min(1).max(200)
  })
  .strict()
export type PlanFeature = z.infer<typeof FeatureSchema>

const VersionSchema = z
  .object({
    version: z.number().int().min(1),
    note: z.string().max(500).optional(),
    entitlements: z.record(z.string(), z.object({ value: z.unknown(), perSeat: z.boolean().optional() }).strict()),
    // Required for self-serve plans (checked below); others may leave it empty.
    policy: z.union([PolicySchema, z.object({}).strict()]),
    features: z.array(FeatureSchema).max(20)
  })
  .strict()

const PlanSchema = z
  .object({
    id: PlanIdSchema,
    kind: z.enum(PLAN_KINDS),
    name: z.string().min(1).max(40),
    sort: z.number().int(),
    public: z.boolean(),
    currentVersion: z.number().int().min(1),
    stripe: z
      .object({
        seatLookupKeys: z.object({ month: LookupKey.optional(), year: LookupKey.optional() }).strict(),
        overageLookupKey: LookupKey.optional()
      })
      .strict()
      .optional(),
    contactUrl: z.string().url().startsWith('https://').optional(),
    priceLabel: z.string().max(40).optional(),
    versions: z.array(VersionSchema).min(1)
  })
  .strict()

export const CatalogFileSchema = z
  .object({
    $comment: z.string().optional(),
    schemaVersion: z.literal(1),
    plans: z.array(PlanSchema).min(1)
  })
  .strict()
export type CatalogFile = z.infer<typeof CatalogFileSchema>

export type PlanConfig = {
  stripe?: { seatLookupKeys: { month?: string; year?: string }; overageLookupKey?: string }
  contactUrl?: string
  priceLabel?: string
}

export type CatalogVersion = {
  version: number
  entitlements: Partial<Record<EntitlementKey, { value: unknown; perSeat: boolean }>>
  policy: PlanPolicy | null
  features: PlanFeature[]
}

export type CatalogPlan = {
  id: string
  kind: PlanKind
  name: string
  sort: number
  public: boolean
  currentVersion: number
  config: PlanConfig
  versions: Map<number, CatalogVersion>
}

export type PlanPriceRow = {
  stripe_price_id: string
  plan_id: string
  plan_version: number | null
  role: 'seat' | 'overage'
  interval: string | null
  lookup_key: string | null
  unit_amount: number | null
  unit_amount_decimal: string | null
  currency: string | null
  active: number
  is_checkout_price: number
  stripe_product_id: string | null
  synced_at: number
}

export type Catalog = {
  /** Changes whenever any plan, version or price row changes (ETag for GET /v1/plans). */
  etag: string
  plans: Map<string, CatalogPlan>
  prices: PlanPriceRow[]
}

export class CatalogUnavailableError extends Error {
  constructor(message = 'plan_catalog_unavailable') {
    super(message)
    this.name = 'CatalogUnavailableError'
  }
}

/** Parses and cross-checks a catalog file. Throws with a readable message on any problem. */
export function parseCatalogFile(input: unknown): CatalogFile {
  const file = CatalogFileSchema.parse(input)
  const ids = new Set<string>()
  for (const plan of file.plans) {
    if (ids.has(plan.id)) {
      throw new Error(`duplicate plan ${plan.id}`)
    }
    ids.add(plan.id)
    const versions = new Set<number>()
    for (const version of plan.versions) {
      if (versions.has(version.version)) {
        throw new Error(`${plan.id}: duplicate version ${version.version}`)
      }
      versions.add(version.version)
      for (const [key, entry] of Object.entries(version.entitlements)) {
        try {
          parseEntitlementValue(key, entry)
        } catch (error) {
          throw new Error(`${plan.id} v${version.version}: ${(error as Error).message}`)
        }
      }
      if (plan.kind === 'self_serve' && !PolicySchema.safeParse(version.policy).success) {
        throw new Error(`${plan.id} v${version.version}: a self-serve plan needs a full policy`)
      }
    }
    if (!versions.has(plan.currentVersion)) {
      throw new Error(`${plan.id}: currentVersion ${plan.currentVersion} is not defined`)
    }
    if (plan.kind === 'self_serve' && !plan.stripe?.seatLookupKeys.month && !plan.stripe?.seatLookupKeys.year) {
      throw new Error(`${plan.id}: a self-serve plan needs a Stripe seat lookup key`)
    }
    if (plan.kind === 'contact_sales' && !plan.contactUrl) {
      throw new Error(`${plan.id}: a contact-sales plan needs contactUrl`)
    }
  }
  if (!file.plans.some((plan) => plan.kind === 'self_serve')) {
    throw new Error('the catalog needs a self-serve plan')
  }
  if (file.plans.filter((plan) => plan.kind === 'trial').length > 1) {
    throw new Error('at most one trial plan')
  }
  return file
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type SqlStatement = { sql: string; params: Array<string | number | null> }
export type AppliedVersion = { plan_id: string; version: number; content_hash: string }

/**
 * The statements that bring D1 to `file`. Refuses (throws) to rewrite a version already applied
 * with different content: a change is a new version. Re-applying the same file is a no-op.
 */
export async function catalogStatements(file: CatalogFile, applied: readonly AppliedVersion[], now: number): Promise<SqlStatement[]> {
  const known = new Map(applied.map((row) => [`${row.plan_id}:${row.version}`, row.content_hash]))
  const statements: SqlStatement[] = []
  for (const plan of file.plans) {
    const config: PlanConfig = {
      ...(plan.stripe ? { stripe: plan.stripe } : {}),
      ...(plan.contactUrl ? { contactUrl: plan.contactUrl } : {}),
      ...(plan.priceLabel ? { priceLabel: plan.priceLabel } : {})
    }
    statements.push({
      sql: `INSERT INTO plans (plan_id, kind, display_name, sort, public, current_version, config_json, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT (plan_id) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name,
              sort = excluded.sort, public = excluded.public, current_version = excluded.current_version,
              config_json = excluded.config_json, updated_at = excluded.updated_at
            WHERE plans.kind <> excluded.kind OR plans.display_name <> excluded.display_name OR plans.sort <> excluded.sort
              OR plans.public <> excluded.public OR plans.current_version <> excluded.current_version
              OR plans.config_json <> excluded.config_json`,
      params: [plan.id, plan.kind, plan.name, plan.sort, plan.public ? 1 : 0, plan.currentVersion, JSON.stringify(config), now]
    })
    for (const version of plan.versions) {
      const entitlements = JSON.stringify(version.entitlements)
      const features = JSON.stringify(version.features)
      const policy = JSON.stringify(version.policy)
      const hash = await sha256(`${entitlements}\n${features}\n${policy}`)
      const existing = known.get(`${plan.id}:${version.version}`)
      if (existing === hash) {
        continue
      }
      if (existing !== undefined) {
        throw new Error(`${plan.id} v${version.version} was already applied with different content; add a new version instead`)
      }
      statements.push({
        sql: `INSERT INTO plan_versions (plan_id, version, entitlements_json, features_json, policy_json, content_hash, note, created_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        params: [plan.id, version.version, entitlements, features, policy, hash, version.note ?? null, now]
      })
    }
  }
  return statements
}

/** Applies a catalog file to a D1 binding (tests, and any in-Worker use). Returns rows written. */
export async function applyCatalog(db: D1Database, input: unknown, now: number): Promise<number> {
  const file = parseCatalogFile(input)
  const applied = (await db.prepare('SELECT plan_id, version, content_hash FROM plan_versions').all<AppliedVersion>()).results
  const statements = await catalogStatements(file, applied, now)
  const results = statements.length > 0 ? await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params))) : []
  invalidateCatalog(db)
  // Rows actually written (an unchanged plan row is skipped by its upsert's WHERE).
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
}

// Per-isolate cache: the catalog changes rarely (an apply or a Stripe price sync); a minute of
// staleness only affects display, and every write path invalidates it.
const CACHE_MS = 60_000
const cache = new WeakMap<D1Database, { at: number; catalog: Catalog }>()

export function invalidateCatalog(db: D1Database): void {
  cache.delete(db)
}

type PlanRow = {
  plan_id: string
  kind: PlanKind
  display_name: string
  sort: number
  public: number
  current_version: number
  config_json: string
  updated_at: number
}
type VersionRow = { plan_id: string; version: number; entitlements_json: string; features_json: string; policy_json: string; content_hash: string }

/** The catalog from D1. Throws CatalogUnavailableError when it was never applied or is unreadable. */
export async function loadCatalog(db: D1Database, now: number = Date.now()): Promise<Catalog> {
  const hit = cache.get(db)
  if (hit && now - hit.at < CACHE_MS && now >= hit.at) {
    return hit.catalog
  }
  const [planRows, versionRows, priceRows] = await Promise.all([
    db.prepare('SELECT * FROM plans ORDER BY sort, plan_id').all<PlanRow>(),
    db.prepare('SELECT plan_id, version, entitlements_json, features_json, policy_json, content_hash FROM plan_versions').all<VersionRow>(),
    db.prepare('SELECT * FROM plan_prices ORDER BY stripe_price_id').all<PlanPriceRow>()
  ])
  if (planRows.results.length === 0) {
    throw new CatalogUnavailableError()
  }
  const plans = new Map<string, CatalogPlan>()
  try {
    for (const row of planRows.results) {
      plans.set(row.plan_id, {
        id: row.plan_id,
        kind: row.kind,
        name: row.display_name,
        sort: row.sort,
        public: row.public === 1,
        currentVersion: row.current_version,
        config: JSON.parse(row.config_json) as PlanConfig,
        versions: new Map()
      })
    }
    for (const row of versionRows.results) {
      const plan = plans.get(row.plan_id)
      if (!plan) {
        continue
      }
      const raw = JSON.parse(row.entitlements_json) as Record<string, { value: unknown; perSeat?: boolean }>
      const entitlements: CatalogVersion['entitlements'] = {}
      for (const [key, entry] of Object.entries(raw)) {
        entitlements[key as EntitlementKey] = parseEntitlementValue(key, entry)
      }
      const policy = PolicySchema.safeParse(JSON.parse(row.policy_json))
      plan.versions.set(row.version, {
        version: row.version,
        entitlements,
        policy: policy.success ? policy.data : null,
        features: z.array(FeatureSchema).parse(JSON.parse(row.features_json))
      })
    }
  } catch {
    throw new CatalogUnavailableError('plan_catalog_invalid')
  }
  for (const plan of plans.values()) {
    if (!plan.versions.has(plan.currentVersion)) {
      throw new CatalogUnavailableError('plan_catalog_invalid')
    }
  }
  const etagSource = [
    ...planRows.results.map((row) => `${row.plan_id}:${row.current_version}:${row.updated_at}`),
    ...versionRows.results.map((row) => `${row.plan_id}:${row.version}:${row.content_hash}`),
    ...priceRows.results.map((row) => `${row.stripe_price_id}:${row.synced_at}:${row.is_checkout_price}:${row.active}`)
  ].join('|')
  const catalog: Catalog = { etag: `"c_${(await sha256(etagSource)).slice(0, 20)}"`, plans, prices: priceRows.results }
  cache.set(db, { at: now, catalog })
  return catalog
}

/** The self-serve plan with the lowest sort: whose policy applies to an account with no plan. */
export function defaultSelfServePlan(catalog: Catalog): CatalogPlan {
  const plan = [...catalog.plans.values()].filter((entry) => entry.kind === 'self_serve').sort((a, b) => a.sort - b.sort)[0]
  if (!plan) {
    throw new CatalogUnavailableError('plan_catalog_invalid')
  }
  return plan
}

export function trialPlan(catalog: Catalog): CatalogPlan | null {
  return [...catalog.plans.values()].find((plan) => plan.kind === 'trial') ?? null
}

export function planVersion(plan: CatalogPlan, version: number): CatalogVersion {
  return plan.versions.get(version) ?? plan.versions.get(plan.currentVersion)!
}

/** A version's policy, falling back to the default self-serve plan's current one. */
export function policyFor(catalog: Catalog, plan: CatalogPlan | null, version: number | null): PlanPolicy {
  const own = plan ? planVersion(plan, version ?? plan.currentVersion).policy : null
  if (own) {
    return own
  }
  const fallback = defaultSelfServePlan(catalog)
  const policy = planVersion(fallback, fallback.currentVersion).policy
  if (!policy) {
    throw new CatalogUnavailableError('plan_catalog_invalid')
  }
  return policy
}
