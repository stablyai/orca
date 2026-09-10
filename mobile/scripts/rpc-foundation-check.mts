/** Ledger schema: { baseline, regression, entries: [{ id, description, status:
 * 'reference-only' | 'ticket', branch: { sha, file, line }, main: { sha, file, line } }] }.
 * Reference-only entries document unmerged behavior; tickets never authorize changes.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../../src/shared/child-process/run-process.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = resolve(root, 'mobile/rpc-foundation')
const contracts: Record<string, string[]> = {
  step0: [
    'inventory=',
    'support-floor=',
    'deltas=',
    'baseline=',
    'regression=',
    'require-all-current-calls',
    'require-no-dynamic-calls',
    'require-regressions=',
    'require-floor-derived-from-protocol-gate',
    'require-retirement-decision',
    'require-gate-fail-closed',
    'require-below-floor-block-e2e',
    'allow-lane-b-deferred',
    'slice=',
    'pr-head=',
    'require-native-rpc-inventory'
  ],
  step0_5: ['policies=', 'require-partition-fixtures'],
  step1: ['scenarios=', 'goldens=', 'determinism-runs=', 'require-mutants='],
  step2: [
    'slice=',
    'pr-head=',
    'require-no-duplicate-wire-declarations',
    'require-catalog-generated-no-drift',
    'require-protocol-model',
    'require-no-protocol-diff',
    'require-parse-parity',
    'require-metro-bundle',
    'require-webview-import-smoke'
  ],
  step3: [
    'slice=',
    'certificate=',
    'require-pairings=',
    'require-transports=',
    'require-mutants',
    'require-branded-target-cases',
    'require-delivery-identity='
  ]
}
const [step, ...args] = process.argv.slice(2)
const flags = new Map<string, string>()
function required(name: string): string {
  const value = flags.get(name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}
function artifact(name: string): string {
  const value = required(name)
  return isAbsolute(value) ? value : resolve(artifacts, value)
}
async function run(args: string[]): Promise<void> {
  const result = await runProcess({
    program: process.execPath,
    args,
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 300_000,
    maxOutputBytes: 2_000_000
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0 || result.timedOut) throw new Error(`Check failed: ${args.join(' ')}`)
}
async function generator(name: string, path: string, extra: string[] = []): Promise<void> {
  await run([
    '--import',
    'tsx',
    `mobile/scripts/${name}.mts`,
    '--check',
    '--output',
    path,
    ...extra
  ])
}
async function checkStep0(): Promise<void> {
  const ledger = JSON.parse(readFileSync(artifact('deltas'), 'utf8'))
  if (ledger.baseline !== required('baseline') || ledger.regression !== required('regression'))
    throw new Error('Ledger provenance differs')
  if (!Array.isArray(ledger.entries) || ledger.entries.length < 7)
    throw new Error('Incomplete named deltas')
  for (const entry of ledger.entries) {
    if (!entry.id || !entry.description || !['reference-only', 'ticket'].includes(entry.status))
      throw new Error('Invalid delta')
    for (const side of ['main', 'branch']) {
      const location = entry[side]
      if (!location?.sha || !location.file || !Number.isInteger(location.line) || location.line < 1)
        throw new Error(`Invalid ${side} provenance: ${entry.id}`)
    }
  }
  if (flags.has('require-all-current-calls') || flags.has('require-no-dynamic-calls')) {
    await generator(
      'rpc-access-inventory',
      artifact('inventory'),
      flags.has('require-no-dynamic-calls') ? ['--require-no-dynamic-calls'] : []
    )
  }
  if (
    flags.has('require-floor-derived-from-protocol-gate') ||
    flags.has('require-retirement-decision')
  )
    await generator('rpc-support-floor', artifact('support-floor'))
  if (flags.has('slice'))
    await generator('rpc-slice-manifest', artifact('slice'), ['--pr-head', required('pr-head')])
  if (flags.has('require-native-rpc-inventory'))
    await generator('rpc-native-inventory', resolve(artifacts, 'native-rpc-inventory.json'))
  for (const flag of ['require-gate-fail-closed', 'require-below-floor-block-e2e']) {
    if (!flags.has(flag)) continue
    if (!flags.has('allow-lane-b-deferred'))
      throw new Error(`--${flag}: not implemented; lane B required`)
    console.log(`--${flag}: deferred to lane B`)
  }
  if (flags.has('require-regressions')) {
    const seeds = JSON.parse(readFileSync(resolve(artifacts, 'regression-seeds.json'), 'utf8'))
    if (seeds.baseline !== required('baseline') || seeds.regression !== required('regression'))
      throw new Error('Regression provenance differs')
    for (const id of required('require-regressions').split(',')) {
      const seed = seeds.tests.find((test: { id: string }) => test.id === id)
      if (!seed || !readFileSync(resolve(root, seed.file), 'utf8').includes(seed.name))
        throw new Error(`Missing regression: ${id}`)
      await run([
        'mobile/node_modules/vitest/vitest.mjs',
        'run',
        '--root',
        'mobile',
        seed.file.replace(/^mobile\//, ''),
        '-t',
        seed.name
      ])
    }
  }
  const ratchet = 'mobile/src/transport/screen-rpc-ratchet.test.ts'
  if (!existsSync(resolve(root, ratchet))) throw new Error('Missing main ratchet')
  await run([
    'mobile/node_modules/vitest/vitest.mjs',
    'run',
    '--root',
    'mobile',
    ratchet.replace(/^mobile\//, '')
  ])
}
try {
  if (!contracts[step]) throw new Error(`Expected subcommand: ${Object.keys(contracts).join(', ')}`)
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '')
    const contract = contracts[step].find((value) => value.replace(/=$/, '') === name)
    if (!args[i].startsWith('--') || !contract || flags.has(name))
      throw new Error(`Unknown or duplicate flag: ${args[i]}`)
    const value = contract.endsWith('=') ? args[++i] : 'true'
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    flags.set(name, value)
  }
  if (step !== 'step0') {
    console.error(`${step}: not implemented`)
    process.exitCode = 2
  } else {
    await checkStep0()
    console.log('step0: all requested checks passed')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
