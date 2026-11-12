// Applies catalog/catalog.json (plans, plan versions: entitlements, features, policy) to a billing
// D1 through wrangler. Validates the file against the entitlement registry first, refuses to
// rewrite a version that is already applied with different content (add a version instead), and
// is a no-op when nothing changed. Prices are not in the catalog: they come from Stripe.
//
//   tsx scripts/catalog-apply.ts --config wrangler.dev.jsonc [--local] [--file catalog/catalog.json] [--dry-run]
//
// Dev only for now: a config whose name contains "prod" is refused unless CATALOG_APPLY_ALLOW_PROD=1
// (the launch runbook step).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogStatements, parseCatalogFile, type AppliedVersion, type SqlStatement } from '../src/catalog'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const config = arg('--config')
const file = arg('--file') ?? 'catalog/catalog.json'
const target = process.argv.includes('--local') ? '--local' : '--remote'
const dryRun = process.argv.includes('--dry-run')
if (!config) {
  console.error('usage: tsx scripts/catalog-apply.ts --config wrangler.dev.jsonc [--local] [--file catalog/catalog.json] [--dry-run]')
  process.exit(2)
}
if (/prod/i.test(config) && process.env.CATALOG_APPLY_ALLOW_PROD !== '1') {
  console.error('Refusing a production config (set CATALOG_APPLY_ALLOW_PROD=1 for the launch step).')
  process.exit(2)
}

function wrangler(args: string[]): string {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'BILLING_DB', target, '-c', config!, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
}

/** SQL literal for a validated parameter (strings single-quoted with quotes doubled). */
function literal(value: string | number | null): string {
  if (value === null) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('non-finite number')
    }
    return String(value)
  }
  return `'${value.replaceAll("'", "''")}'`
}

function inline(statement: SqlStatement): string {
  return `${statement.sql.replace(/\?(\d+)/g, (_, index: string) => literal(statement.params[Number(index) - 1] ?? null))};`
}

const catalog = parseCatalogFile(JSON.parse(readFileSync(file, 'utf8')))
const output = JSON.parse(wrangler(['--json', '--command', 'SELECT plan_id, version, content_hash FROM plan_versions'])) as Array<{
  results: AppliedVersion[]
}>
const applied = output.flatMap((entry) => entry.results)
const statements = await catalogStatements(catalog, applied, Date.now())
const versions = statements.filter((statement) => statement.sql.includes('INSERT INTO plan_versions'))
console.log(`catalog: ${catalog.plans.length} plans; ${versions.length} new version(s); plan rows upserted only if changed`)
if (dryRun) {
  console.log(statements.map(inline).join('\n'))
  process.exit(0)
}
const dir = mkdtempSync(join(tmpdir(), 'orca-catalog-'))
const sqlFile = join(dir, 'catalog.sql')
writeFileSync(sqlFile, statements.map(inline).join('\n'), { mode: 0o600 })
wrangler(['--file', sqlFile])
console.log('applied')
