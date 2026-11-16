#!/usr/bin/env node
// Launch smoke for a deployed sandbox-control Worker: its public /v1/health must say ok, model keys swapped at
// egress (keySwap "on"), and the environment it was deployed as (default "prod"). A prod Worker missing
// SANDBOX_ENV=prod reports something else and fails here, before anything else runs against it.
//   node scripts/launch-smoke.mjs <base url> [expected environment, default prod]
const [base, expected = 'prod'] = process.argv.slice(2)
if (!base) {
  console.error('usage: launch-smoke.mjs <base url> [expected environment]')
  process.exit(2)
}
const response = await fetch(new URL('/v1/health', base), { signal: AbortSignal.timeout(15_000) })
const body = await response.json().catch(() => null)
const problems = []
if (response.status !== 200 || body?.ok !== true) problems.push(`health ${response.status} ${JSON.stringify(body)}`)
if (body?.keySwap !== 'on') problems.push(`keySwap is ${JSON.stringify(body?.keySwap)}, expected "on"`)
if (body?.environment !== expected) problems.push(`environment is ${JSON.stringify(body?.environment)}, expected ${JSON.stringify(expected)}`)
if (problems.length > 0) {
  console.error(`launch smoke FAILED for ${base}:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`launch smoke OK: ${base} is ${expected}, keySwap on`)
