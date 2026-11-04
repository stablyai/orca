import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { runProcess } from '@orca/process-host'
import { runRelayTests } from './run-relay-tests.mjs'

const success = { code: 0, signal: null, timedOut: false }
const databaseUrl = 'postgres://relay_test:relay_test@127.0.0.1:5432/orca_relay_test'
const require = createRequire(import.meta.url)
const cloud = resolve(import.meta.dirname, '../..')

function temporary(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relay-runner-contract-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function start(t, options = {}) {
  const scratchParent = temporary(t)
  const calls = []
  const reports = []
  const events = new EventEmitter()
  const env = { ORCA_RELAY_TEST_POSTGRES_URL: databaseUrl, PRESERVED: 'yes', ...options.env }
  const pending = runRelayTests({
    cwd: join(scratchParent, 'relay'),
    cli: join(scratchParent, 'vitest.mjs'),
    parallelism: 4,
    ...options,
    env,
    events,
    scratchParent,
    report: (message) => reports.push(message),
    run: (spec) => {
      const deferred = Promise.withResolvers()
      calls.push({ spec, ...deferred })
      return deferred.promise
    }
  })
  return { pending, calls, reports, events, scratchParent, env }
}

function finish(call, result = success, closed = true) {
  if (closed) {
    call.spec.onChildTerminated()
  }
  call.resolve(result)
}

function assertClean(harness) {
  assert.deepEqual(readdirSync(harness.scratchParent), [])
  assert.equal(harness.events.listenerCount('SIGINT'), 0)
  assert.equal(harness.events.listenerCount('SIGTERM'), 0)
}

test('overlaps both projects within the worker budget and isolates their scratch and caches', async (t) => {
  const h = start(t)
  assert.equal(h.calls.length, 2)
  const [regular, postgres] = h.calls.map((call) => call.spec)
  assert.deepEqual(regular.args.slice(1), ['run', '--project=relay', '--maxWorkers=2'])
  assert.deepEqual(postgres.args.slice(1), ['run', '--project=relay-postgres', '--maxWorkers=1'])
  assert.notEqual(regular.env.TMPDIR, postgres.env.TMPDIR)
  assert.notEqual(regular.env.ORCA_RELAY_TEST_CACHE_DIR, postgres.env.ORCA_RELAY_TEST_CACHE_DIR)
  for (const spec of [regular, postgres]) {
    assert.equal(spec.env.TMP, spec.env.TMPDIR)
    assert.equal(spec.env.TEMP, spec.env.TMPDIR)
    assert.equal(spec.env.ORCA_RELAY_TEST_CACHE_DIR, join(spec.env.TMPDIR, 'cache'))
    assert.equal(spec.env.ORCA_RELAY_TEST_POSTGRES_URL, databaseUrl)
    assert.equal(spec.env.PRESERVED, 'yes')
    assert.equal(spec.env.ORCA_BACKGROUND_LAUNCH, '1')
    assert.ok(existsSync(spec.env.TMPDIR))
    assert.equal(spec.timeoutMs, null)
    assert.equal(typeof spec.terminationBarrier.force, 'function')
  }
  assert.equal(regular.signal, postgres.signal)
  let settled = false
  h.pending.then(() => {
    settled = true
  })
  finish(h.calls[0], { ...success, code: 7 })
  await setImmediate()
  assert.equal(settled, false)
  assert.equal(postgres.signal.aborted, false)
  assert.ok(existsSync(postgres.env.TMPDIR))
  finish(h.calls[1])
  assert.equal(await h.pending, 7)
  assertClean(h)
})

for (const [name, options] of [
  ['selectors', { args: ['src/assignment.test.ts', '-t', 'requested behavior'] }],
  [
    'alternate PostgreSQL',
    { env: { ORCA_IDLE_REHOME_POSTGRES_URL: 'postgres://localhost:55440/relay' } }
  ],
  ['application database', { env: { DATABASE_URL: databaseUrl } }],
  ['one CPU', { parallelism: 1 }],
  ['two CPUs', { parallelism: 2 }]
]) {
  test(`retains the original single run for ${name}`, async (t) => {
    const h = start(t, options)
    assert.equal(h.calls.length, 1)
    const { spec } = h.calls[0]
    assert.deepEqual(spec.args.slice(1), ['run', ...(options.args ?? [])])
    for (const [key, value] of Object.entries(h.env)) {
      assert.equal(spec.env[key], value)
    }
    finish(h.calls[0])
    assert.equal(await h.pending, 0)
    assertClean(h)
  })
}

for (const [name, result] of [
  ['null exit code', { ...success, code: null }],
  ['termination signal', { ...success, signal: 'SIGTERM' }],
  ['timeout', { ...success, timedOut: true }]
]) {
  test(`fails a ${name} even when other result fields indicate success`, async (t) => {
    const h = start(t)
    finish(h.calls[0], result)
    finish(h.calls[1])
    assert.equal(await h.pending, 1)
    assertClean(h)
  })
}

test('fails and retains scratch when a child never reports closure', async (t) => {
  const h = start(t)
  finish(h.calls[0], success, false)
  finish(h.calls[1])
  assert.equal(await h.pending, 1)
  assert.ok(existsSync(h.calls[0].spec.env.TMPDIR))
  assert.match(String(h.reports[0]), /closure is unverifiable; retained/)
  assert.equal(h.events.listenerCount('SIGINT'), 0)
  assert.equal(h.events.listenerCount('SIGTERM'), 0)
})

for (const [signal, exitCode, laterSignal] of [
  ['SIGINT', 130, 'SIGTERM'],
  ['SIGTERM', 143, 'SIGINT']
]) {
  test(`${signal} cancels every child and retains scratch despite root close callbacks`, async (t) => {
    const h = start(t)
    h.events.emit(signal)
    h.events.emit(laterSignal)
    for (const call of h.calls) {
      assert.equal(call.spec.signal.aborted, true)
      finish(call)
    }
    assert.equal(await h.pending, exitCode)
    for (const call of h.calls) {
      assert.ok(existsSync(call.spec.env.TMPDIR))
    }
    assert.match(String(h.reports[0]), /closure is unverifiable; retained/)
    assert.equal(h.events.listenerCount('SIGINT'), 0)
    assert.equal(h.events.listenerCount('SIGTERM'), 0)
  })
}

for (const verified of [1, 2]) {
  test(`requires verification of both cancelled trees (${verified} verified)`, async (t) => {
    const h = start(t)
    h.events.emit('SIGINT')
    for (const call of h.calls.slice(0, verified)) {
      // An unspawned handle proves absence without signalling a real process.
      assert.equal(await call.spec.terminationBarrier.force({ kill: () => true }), true)
    }
    for (const call of h.calls) {
      finish(call)
    }
    assert.equal(await h.pending, 130)
    if (verified === 2) {
      assertClean(h)
    } else {
      assert.ok(existsSync(h.calls[0].spec.env.TMPDIR))
    }
  })
}

test('reports a spawn failure and waits for its cancelled peer before returning', async (t) => {
  const h = start(t)
  const failure = new Error('fixture spawn failed')
  h.calls[0].reject(failure)
  let settled = false
  h.pending.then(() => {
    settled = true
  })
  await setImmediate()
  assert.equal(h.calls[1].spec.signal.aborted, true)
  assert.equal(settled, false)
  finish(h.calls[1])
  assert.equal(await h.pending, 1)
  assert.equal(h.reports[0], failure)
  assert.ok(existsSync(h.calls[1].spec.env.TMPDIR))
})

test('launches with only the Cloud dependency link and no root install or compiled host package', async (t) => {
  const root = temporary(t)
  const standalone = join(root, 'cloud')
  const manifest = JSON.parse(readFileSync(join(cloud, 'package.json'), 'utf8'))
  const dependency = manifest.devDependencies['@orca/process-host']
  assert.equal(dependency, 'link:../src/packages/process-host')
  const packageDir = resolve(standalone, dependency.slice('link:'.length))
  mkdirSync(packageDir, { recursive: true })
  for (const file of ['package.json', 'src']) {
    cpSync(join(cloud, '..', 'src', 'packages', 'process-host', file), join(packageDir, file), {
      recursive: true
    })
  }
  const scripts = join(standalone, 'dev', 'scripts')
  mkdirSync(scripts, { recursive: true })
  cpSync(join(cloud, 'dev', 'scripts', 'run-relay-tests.mjs'), join(scripts, 'run-relay-tests.mjs'))
  writeFileSync(join(standalone, 'package.json'), JSON.stringify(manifest))
  mkdirSync(join(standalone, 'apps', 'relay'), { recursive: true })
  mkdirSync(join(standalone, 'node_modules', '@orca'), { recursive: true })
  symlinkSync(
    packageDir,
    join(standalone, 'node_modules', '@orca', 'process-host'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const fakeVitest = join(standalone, 'node_modules', 'vitest')
  mkdirSync(fakeVitest)
  writeFileSync(join(fakeVitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}')
  writeFileSync(
    join(fakeVitest, 'vitest.mjs'),
    'console.log(JSON.stringify({args:process.argv.slice(2), background:process.env.ORCA_BACKGROUND_LAUNCH, database:process.env.ORCA_RELAY_TEST_POSTGRES_URL}))'
  )
  assert.equal(existsSync(join(root, 'node_modules')), false)
  assert.equal(existsSync(join(packageDir, 'dist')), false)
  const result = await runProcess({
    program: process.execPath,
    args: [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      '--conditions=orca-source',
      join(scripts, 'run-relay-tests.mjs'),
      'src/requested.test.ts'
    ],
    cwd: standalone,
    timeoutMs: 15_000,
    terminationBarrier: true,
    env: {
      ...process.env,
      NODE_PATH: '',
      NODE_OPTIONS: '',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_RELAY_TEST_POSTGRES_URL: databaseUrl
    }
  })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['run', 'src/requested.test.ts'],
    background: '1',
    database: databaseUrl
  })
  assert.equal(existsSync(join(packageDir, 'dist')), false)
})
