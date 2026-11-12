// The repo catalog (catalog/catalog.json) for tests, with a legacy BILLING_PLANS override carried
// into the Team plan's version, so a test that tunes the legacy catalog gets the same terms in
// every ENTITLEMENTS_MODE. A malformed override is left out (legacy fails closed on it anyway).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCatalogFile, type CatalogFile } from '../src/catalog'

export function repoCatalog(): CatalogFile {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../catalog/catalog.json', import.meta.url).href), 'utf8')) as CatalogFile
}

export function testCatalog(billingPlans?: string): CatalogFile {
  const catalog = repoCatalog()
  let team: Record<string, unknown> = {}
  try {
    team = (billingPlans ? (JSON.parse(billingPlans) as { team?: Record<string, unknown> }).team : undefined) ?? {}
  } catch {
    return catalog
  }
  const plan = catalog.plans.find((entry) => entry.id === 'team')!
  const version = plan.versions.find((entry) => entry.version === plan.currentVersion)!
  const policy = version.policy as Extract<typeof version.policy, { paymentGraceHours: number }>
  const set = (key: string, apply: (value: never) => void) => {
    if (team[key] !== undefined) {
      apply(team[key] as never)
    }
  }
  set('label', (value: string) => (plan.name = value))
  set('includedHoursPerSeat', (value: number) => (version.entitlements.sandbox_hours_monthly = { value, perSeat: true }))
  set('concurrentSandboxesPerSeat', (value: number) => {
    version.entitlements.max_concurrent_sandboxes = { value, perSeat: true }
    version.entitlements.max_concurrent_sandboxes_per_member = { value }
  })
  set('machineSizes', (value: string[]) => (version.entitlements.machine_sizes = { value }))
  set('paymentGraceHours', (value: number) => (policy.paymentGraceHours = value))
  set('seatTrueDownHours', (value: number) => (policy.seatTrueDownHours = value))
  set('warnAtPercent', (value: number[]) => (policy.warnAtPercent = value))
  set('defaultSpendCapCents', (value: number) => (policy.overage.defaultSpendCapCents = value))
  set('maxSpendCapCents', (value: number) => (policy.overage.maxSpendCapCents = value))
  try {
    return parseCatalogFile(catalog)
  } catch {
    return repoCatalog()
  }
}
