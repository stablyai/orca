// Copies observations written under ORCA_LAYOUT_COMPAT_REPORT_DIR (<scenario>.<platform>.json)
// into tests/e2e/layout-compat-baselines.json. Usage: node <this> <report dir>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const reportDir = process.argv[2]
if (!reportDir) {
  throw new Error('usage: record-layout-compat-baselines.mjs <report dir>')
}
const baselineFile = path.join(
  import.meta.dirname,
  '..',
  '..',
  'tests',
  'e2e',
  'layout-compat-baselines.json'
)
const baselines = JSON.parse(readFileSync(baselineFile, 'utf8'))
for (const name of readdirSync(reportDir).filter((file) => file.endsWith('.json'))) {
  const match = /^(.+)\.(darwin|linux|win32)\.json$/.exec(name)
  if (!match) {
    continue
  }
  const [, scenario, platform] = match
  baselines.scenarios[scenario] = {
    ...baselines.scenarios[scenario],
    [platform]: JSON.parse(readFileSync(path.join(reportDir, name), 'utf8'))
  }
  console.log(`recorded ${scenario} (${platform})`)
}
baselines.scenarios = Object.fromEntries(
  Object.entries(baselines.scenarios).sort(([a], [b]) => a.localeCompare(b))
)
writeFileSync(baselineFile, `${JSON.stringify(baselines, null, 2)}\n`)
