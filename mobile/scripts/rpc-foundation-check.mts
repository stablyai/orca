/** Ledger schema: { baseline, regression, entries: [{ id, description, status:
 * 'reference-only' | 'ticket', branch: { sha, file, line }, main: { sha, file, line } }] }.
 * Tickets require only main provenance; reference-only entries require both sides.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcess } from '../../src/shared/child-process/run-process.ts'

const root = resolve(import.meta.dirname, '../..')
const artifacts = resolve(root, 'mobile/rpc-foundation')
const step0Flags = [
  'inventory=',
  'deltas=',
  'baseline=',
  'regression=',
  'require-all-current-calls',
  'require-regressions=',
  'require-native-rpc-inventory'
]
const [step, ...args] = process.argv.slice(2)
const flags = new Map<string, string>()
function required(name: string): string {
  const value = flags.get(name)
  if (!value) {
    throw new Error(`Missing --${name}`)
  }
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
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Check failed: ${args.join(' ')}`)
  }
}
/** Any failure is a gate failure: an unresolvable sha and a missing path share git's wording. */
async function gitLineCount(sha: string, file: string): Promise<number> {
  const result = await runProcess({
    program: 'git',
    args: ['show', `${sha}:${file}`],
    cwd: root,
    maxOutputBytes: 8_000_000
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`Unresolvable provenance ${sha}:${file}: ${result.stderr.trim()}`)
  }
  return result.stdout.replace(/\n$/, '').split('\n').length
}
type VitestCase = { fullName: string; status: string }
/** Exit 0 is not evidence the pinned test ran: a `-t` filter that matches nothing and an
 *  `it.skip` are both a green skip. Require the named case itself to report `passed`, which a
 *  retitled test (no match) and a skipped test (wrong status) each fail. Without a name, every
 *  case in the file must pass, so nothing can be skipped away either. */
async function vitest(file: string, name?: string): Promise<void> {
  const report = join(tmpdir(), `rpc-foundation-${randomUUID()}.json`)
  const label = name ? `${file} -t ${name}` : file
  try {
    await run([
      'mobile/node_modules/vitest/vitest.mjs',
      'run',
      '--root',
      'mobile',
      file.replace(/^mobile\//, ''),
      ...(name ? ['-t', name] : []),
      '--reporter=json',
      `--outputFile=${report}`
    ])
    const summary = JSON.parse(readFileSync(report, 'utf8'))
    if (summary.success !== true || summary.numFailedTestSuites !== 0) {
      throw new Error(`${label}: suite did not succeed`)
    }
    const cases: VitestCase[] = (summary.testResults ?? []).flatMap(
      (suite: { assertionResults?: VitestCase[] }) => suite.assertionResults ?? []
    )
    const matched = name ? cases.filter((item) => item.fullName.includes(name)) : cases
    if (!matched.length) {
      throw new Error(`${label}: no test of that name ran`)
    }
    const unproven = matched.filter((item) => item.status !== 'passed')
    if (unproven.length) {
      throw new Error(
        `${label}: ${unproven.map((item) => `${item.status} ${item.fullName}`).join('; ')}`
      )
    }
  } finally {
    rmSync(report, { force: true })
  }
}
async function generator(name: string, path: string, extra: string[] = []): Promise<void> {
  await run([
    'mobile/node_modules/tsx/dist/cli.mjs',
    `mobile/scripts/${name}.mts`,
    '--check',
    '--output',
    path,
    ...extra
  ])
}
async function checkStep0(): Promise<void> {
  const ledger = JSON.parse(readFileSync(artifact('deltas'), 'utf8'))
  if (ledger.baseline !== required('baseline') || ledger.regression !== required('regression')) {
    throw new Error('Ledger provenance differs')
  }
  if (!Array.isArray(ledger.entries) || ledger.entries.length < 7) {
    throw new Error('Incomplete named deltas')
  }
  for (const entry of ledger.entries) {
    if (!entry.id || !entry.description || !['reference-only', 'ticket'].includes(entry.status)) {
      throw new Error('Invalid delta')
    }
    for (const side of entry.status === 'ticket' ? ['main'] : ['main', 'branch']) {
      const location = entry[side]
      if (
        !location?.sha ||
        !location.file ||
        !Number.isInteger(location.line) ||
        location.line < 1
      ) {
        throw new Error(`Invalid ${side} provenance: ${entry.id}`)
      }
      if ((await gitLineCount(location.sha, location.file)) < location.line) {
        throw new Error(
          `${side} provenance past end of file: ${entry.id} ${location.file}:${location.line}`
        )
      }
    }
  }
  if (flags.has('require-all-current-calls')) {
    await generator('rpc-access-inventory', artifact('inventory'))
  }
  if (flags.has('require-native-rpc-inventory')) {
    await generator('rpc-native-inventory', resolve(artifacts, 'native-rpc-inventory.json'))
  }
  if (flags.has('require-regressions')) {
    const seeds = JSON.parse(readFileSync(resolve(artifacts, 'regression-seeds.json'), 'utf8'))
    if (seeds.baseline !== required('baseline') || seeds.regression !== required('regression')) {
      throw new Error('Regression provenance differs')
    }
    await generator('rpc-reference-regressions', resolve(artifacts, 'reference-regressions.json'), [
      '--regression',
      required('regression')
    ])
    for (const id of required('require-regressions').split(',')) {
      const seed = seeds.tests.find((test: { id: string }) => test.id === id)
      if (!seed || !readFileSync(resolve(root, seed.file), 'utf8').includes(seed.name)) {
        throw new Error(`Missing regression: ${id}`)
      }
      await vitest(seed.file, seed.name)
    }
  }
  const ratchet = 'mobile/src/transport/screen-rpc-ratchet.test.ts'
  if (!existsSync(resolve(root, ratchet))) {
    throw new Error('Missing main ratchet')
  }
  await vitest(ratchet)
}
try {
  if (step !== 'step0') {
    throw new Error('Expected subcommand: step0')
  }
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '')
    const contract = step0Flags.find((value) => value.replace(/=$/, '') === name)
    if (!args[i].startsWith('--') || !contract || flags.has(name)) {
      throw new Error(`Unknown or duplicate flag: ${args[i]}`)
    }
    const value = contract.endsWith('=') ? args[++i] : 'true'
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    flags.set(name, value)
  }
  await checkStep0()
  console.log('step0: all requested checks passed')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
