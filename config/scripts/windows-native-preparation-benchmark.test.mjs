import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'
import {
  assertNativeColdProbe,
  assertNoHeaderDownloads,
  validateObservedPreparation
} from './benchmark-windows-native-preparation.mjs'
import {
  changedEnvironmentNames,
  environmentReceipt,
  installNativeBenchmarkObserver
} from './windows-native-benchmark-observer.mjs'

const original = { Path: 'unchanged', TOKEN: 'private' }
const parent = environmentReceipt(original)
const captureEnvironment = { ...original, VCINSTALLDIR: 'compiler' }
const call = (phase, code = 0, prepared = false) => ({
  phase,
  code,
  environment: prepared ? environmentReceipt(captureEnvironment) : parent,
  changedNames: prepared ? ['vcinstalldir'] : []
})
const receipt = (calls) => ({ parentBefore: parent, parentAfter: parent, calls })
const candidate = () =>
  receipt([call('probe', 1), call('discovery'), call('capture'), call('preparation', 0, true)])

for (const [variant, warm, calls] of [
  [
    'control',
    false,
    [call('addon-build'), call('addon-build'), call('addon-build'), call('addon-build')]
  ],
  ['control', true, []],
  ['candidate', false, candidate().calls],
  ['candidate', true, [call('probe'), call('preparation')]],
  [
    'fallback',
    false,
    [call('probe', 1), call('discovery'), call('capture', 7), call('preparation')]
  ],
  ['fallback', true, [call('probe'), call('preparation')]]
]) {
  test(`qualifies ${variant} ${warm ? 'warm' : 'cold'} receipts`, () =>
    validateObservedPreparation(receipt(calls), variant, warm))
}

test('fails closed on an unobserved or unchanged candidate', () => {
  assert.throws(() => validateObservedPreparation(receipt([]), 'candidate'), /discovery count/)
  const missingCapture = candidate()
  missingCapture.calls.splice(2, 1)
  assert.throws(
    () => validateObservedPreparation(missingCapture, 'candidate'),
    /developer command count/
  )
  const unchanged = candidate()
  unchanged.calls[3] = call('preparation')
  assert.throws(() => validateObservedPreparation(unchanged, 'candidate'), /not applied/)
})

test('rejects failed preparation and unrelated or persistent environment changes', () => {
  for (const mutate of [
    (value) => {
      value.calls[3].code = 2
    },
    (value) => {
      value.calls[3].changedNames = ['token']
    },
    (value) => {
      value.parentAfter = environmentReceipt(captureEnvironment)
    },
    (value) => {
      value.calls[2].timedOut = true
    }
  ]) {
    const value = candidate()
    mutate(value)
    assert.throws(() => validateObservedPreparation(value, 'candidate'))
  }
  assert.throws(
    () =>
      validateObservedPreparation(
        receipt([call('probe'), call('preparation', 0, true)]),
        'candidate',
        true
      ),
    /changed compiler/
  )
})

test('requires all four initial addon failures and excludes timed header downloads', () => {
  const result = {
    code: 1,
    stderr: [
      'node-pty',
      '@orca/windows-registry',
      '@orca/windows-security',
      '@vscode/windows-process-tree'
    ]
      .map((name) => `${name}: unavailable`)
      .join('\n')
  }
  assertNativeColdProbe(result)
  assert.throws(() =>
    assertNativeColdProbe({ ...result, stderr: result.stderr.replace('node-pty:', 'missing:') })
  )
  assertNoHeaderDownloads({ stdout: '', stderr: 'gyp info find VS using VS2026' })
  assert.throws(
    () =>
      assertNoHeaderDownloads({
        stdout: '',
        stderr: 'gyp http GET https://nodejs.org/header.tar.gz'
      }),
    /downloaded/
  )
})

test('uses case-insensitive environment comparisons and never publishes values', () => {
  assert.equal(
    environmentReceipt(original).hash,
    environmentReceipt({ PATH: 'unchanged', token: 'private' }).hash
  )
  assert.deepEqual(
    changedEnvironmentNames(original, {
      PATH: 'unchanged',
      TOKEN: 'private',
      VCINSTALLDIR: 'compiler'
    }),
    ['vcinstalldir']
  )
  assert(!JSON.stringify(parent).includes('private'))
  assert.throws(() => environmentReceipt({ PATH: 'first', Path: 'second' }), /Duplicate/)
})

test('writes an empty warm trace and observes calls without changing execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-observer-test-'))
  try {
    const output = join(directory, 'trace.json')
    const result = { code: 0, stdout: 'original stdout', stderr: '', timedOut: false }
    const seen = []
    const api = {
      runProcessSync: (spec) => {
        seen.push(spec)
        return result
      }
    }
    installNativeBenchmarkObserver(api, output, original)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).calls, [])
    const spec = { program: 'vswhere.exe', args: ['-latest'], stdio: 'pipe' }
    assert.equal(api.runProcessSync(spec), result)
    assert.deepEqual(seen, [spec])
    const value = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(value.calls[0].phase, 'discovery')
    assert.equal(value.calls[0].stdoutBytes, result.stdout.length)
    assert.equal(value.parentBefore.hash, value.parentAfter.hash)
    assert(!readFileSync(output, 'utf8').includes('original stdout'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preload observes the CJS process-host export imported by production ESM code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-observer-esm-test-'))
  try {
    const trace = join(directory, 'trace.json')
    const program = `import { runProcessSync } from '@orca/process-host'; const value = runProcessSync({program:process.execPath,args:['-e','process.stdout.write("proof")']}); if(value.stdout !== 'proof') process.exit(2);`
    const result = await runProcess({
      program: process.execPath,
      args: [
        '--import',
        pathToFileURL(join(import.meta.dirname, 'windows-native-benchmark-observer.mjs')).href,
        '--input-type=module',
        '-e',
        program
      ],
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_NATIVE_BENCHMARK_TRACE: trace }
    })
    assert.equal(result.code, 0, result.stderr)
    const value = JSON.parse(readFileSync(trace, 'utf8'))
    assert.equal(value.calls.length, 1)
    assert.equal(value.calls[0].code, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('manual workflow freezes source and limits Windows occupancy without changing a PR gate', () => {
  const workflow = parse(
    readFileSync(
      join(import.meta.dirname, '../../.github/workflows/windows-native-preparation-benchmark.yml'),
      'utf8'
    )
  )
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.equal(workflow.jobs.compare.strategy['max-parallel'], 2)
  assert.deepEqual(workflow.jobs.compare.strategy.matrix.os, ['windows-2022', 'windows-11-arm'])
  assert.equal(workflow.jobs.compare.steps[0].with.ref, '${{ inputs.source_sha }}')
  const install = workflow.jobs.compare.steps.find(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  assert.equal(install.with['native-runtime'], 'none')
  assert.equal(install.with['node-version'], '24.22.1')
  assert.equal(install.with['cache-pnpm-store'], 'false')
  assert.equal(workflow.jobs.compare.steps.at(-1).if, 'always()')
  assert(!Object.hasOwn(workflow.jobs, 'verify'))
})

test('source validation allows owned workflow receipts but rejects unrelated untracked source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-output-ignore-'))
  const git = async (args) => {
    const result = await runProcess({ program: 'git', args, cwd: directory, timeoutMs: 10_000 })
    assert.equal(result.code, 0)
    assert(!result.timedOut && !result.outputTruncated)
    return result.stdout
  }
  try {
    await git(['init', '--quiet'])
    writeFileSync(
      join(directory, '.gitignore'),
      readFileSync(join(import.meta.dirname, '../../.gitignore'))
    )
    await git(['add', '.gitignore'])
    const output = join(directory, '.build/windows-native-benchmark')
    mkdirSync(join(output, 'security'), { recursive: true })
    writeFileSync(
      join(output, 'job-start.json'),
      JSON.stringify({ startedAt: new Date().toISOString() })
    )
    writeFileSync(
      join(output, 'security/receipt.json'),
      JSON.stringify({ qualification: 'incomplete' })
    )
    const untracked = ['ls-files', '--others', '--exclude-standard']
    assert.equal(await git(untracked), '')
    mkdirSync(join(directory, 'config/scripts'), { recursive: true })
    writeFileSync(
      join(directory, 'config/scripts/untracked-source.mjs'),
      'export const source = true'
    )
    writeFileSync(join(directory, '.build/unrelated-source.mjs'), 'export const source = true')
    assert.deepEqual((await git(untracked)).trim().split('\n').sort(), [
      '.build/unrelated-source.mjs',
      'config/scripts/untracked-source.mjs'
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
