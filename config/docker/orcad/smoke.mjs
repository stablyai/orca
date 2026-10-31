import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
const envIndex = args.indexOf('--env-file')
const envFile = envIndex === -1 ? resolve(import.meta.dirname, '.env') : resolve(args[envIndex + 1])
const project = `orcad-fixture-${randomBytes(5).toString('hex')}`
const reportDir = resolve(root, '.bench-fixtures', project)
const scratch = await mkdtemp(join(tmpdir(), 'orcad-docker-'))
const server = createServer()
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const port = server.address().port
await new Promise((done) => server.close(done))
const environment = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  ORCAD_PUBLISH_PORT: String(port),
  ORCAD_PUBLISH_ADDRESS: '127.0.0.1',
  ORCAD_PAIRING_ADDRESS: `127.0.0.1:${port}`
}
const composeArgs = [
  'compose',
  '--env-file',
  envFile,
  '-f',
  resolve(import.meta.dirname, 'compose.yaml'),
  '-p',
  project
]
const report = { project, port, startedAt: new Date().toISOString(), stages: [] }

async function docker(argv, timeoutMs = 180000, allowFailure = false) {
  const result = await runProcess({
    program: 'docker',
    args: argv,
    cwd: root,
    env: environment,
    timeoutMs,
    maxOutputBytes: 1024 * 1024
  })
  if (!allowFailure && (result.code !== 0 || result.timedOut || result.outputTruncated)) {
    throw new Error(`docker ${argv.slice(0, 2).join(' ')} failed: ${result.stderr.slice(-4000)}`)
  }
  return result
}
const compose = (argv, timeoutMs, allowFailure) =>
  docker([...composeArgs, ...argv], timeoutMs, allowFailure)

async function healthy() {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const probe = await compose(
      ['exec', '-T', 'orcad', 'node', '/opt/orca/docker/healthcheck.cjs'],
      20000,
      true
    )
    if (probe.code === 0) {
      return
    }
    await new Promise((done) => setTimeout(done, 1000))
  }
  throw new Error('fixture failed to become healthy')
}

async function containerId() {
  return (await compose(['ps', '--all', '--quiet', 'orcad'])).stdout.trim()
}

async function verify(stage, create = false) {
  const id = await containerId()
  await docker(['cp', join(scratch, 'fixture-state.cjs'), `${id}:/tmp/fixture-state.cjs`])
  const state = await compose([
    'exec',
    '-T',
    'orcad',
    'node',
    '/tmp/fixture-state.cjs',
    ...(create ? ['--create'] : [])
  ])
  const checked = JSON.parse(state.stdout.trim().split('\n').at(-1))
  assert.equal(checked.machineId, report.machineId ?? checked.machineId)
  report.machineId = checked.machineId
  const client = await runProcess({
    program: process.execPath,
    args: [
      join(scratch, 'fixture-client.cjs'),
      join(scratch, 'pairing'),
      join(scratch, 'client-status.json'),
      ...(create ? ['--create'] : [])
    ],
    cwd: scratch,
    env: environment,
    timeoutMs: 20000
  })
  assert.equal(client.code, 0, client.stderr)
  const status = JSON.parse(client.stdout.trim())
  report.stages.push({ stage, containerId: id, state: checked, client: status })
  console.log(`${stage}: authenticated client, workspace, journal and sealed placeholder passed`)
}

try {
  const info = await docker(['info', '--format', '{{json .ServerVersion}}'])
  report.dockerVersion = JSON.parse(info.stdout)
  await mkdir(reportDir, { recursive: true })
  await build({
    entryPoints: ['fixture-state', 'fixture-client'].map((name) =>
      resolve(import.meta.dirname, `${name}.mjs`)
    ),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outdir: scratch,
    outExtension: { '.js': '.cjs' },
    logLevel: 'warning'
  })
  await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180'])
  await healthy()
  const ready = JSON.parse(
    (await compose(['exec', '-T', 'orcad', 'cat', '/run/orca/readiness.json'])).stdout
  )
  assert.equal(ready.pairing.available, true)
  assert.equal(ready.health.terminalDaemon.selfTest.coverage, 'pty-spawn')
  await writeFile(join(scratch, 'pairing'), ready.pairing.url, { mode: 0o600 })
  report.build = JSON.parse(
    (await compose(['exec', '-T', 'orcad', 'cat', '/opt/orca/docker/build.json'])).stdout
  )
  report.providers = JSON.parse(
    (await compose(['exec', '-T', 'orcad', 'cat', '/opt/orca/providers/manifest.json'])).stdout
  )
  assert.ok(report.providers.some((provider) => provider.package === '@anthropic-ai/claude-code'))
  const version = await compose(['exec', '-T', 'orcad', 'claude', '--version'])
  assert.ok(
    version.stdout.includes(
      report.providers.find((provider) => provider.command === 'claude').version
    )
  )
  report.claudeVersion = version.stdout.trim()
  const loginVersion = await compose([
    'exec',
    '-T',
    'orcad',
    '/bin/bash',
    '-lc',
    'claude --version'
  ])
  assert.equal(loginVersion.stdout.trim(), report.claudeVersion)
  report.claudeLoginShellVersion = loginVersion.stdout.trim()
  report.image = JSON.parse(
    (await docker(['inspect', '--format', '{{json .Image}}', await containerId()])).stdout
  )
  await verify('initial', true)
  await compose([
    'exec',
    '-T',
    'orcad',
    'node',
    '/tmp/fixture-state.cjs',
    '--invalidate-health-grant'
  ])
  try {
    const failedProbe = await compose(
      ['exec', '-T', 'orcad', 'node', '/opt/orca/docker/healthcheck.cjs'],
      20000,
      true
    )
    assert.notEqual(failedProbe.code, 0)
    assert.equal(failedProbe.timedOut, false)
    report.negativeHealthCredential = {
      simulation: 'unregistered-startup-token',
      code: failedProbe.code,
      diagnosis: failedProbe.stderr.trim()
    }
  } finally {
    await compose([
      'exec',
      '-T',
      'orcad',
      'node',
      '/tmp/fixture-state.cjs',
      '--restore-health-grant'
    ])
  }
  await healthy()
  const daemonPid = String(ready.health.terminalDaemon.pid)
  await compose([
    'exec',
    '-T',
    'orcad',
    'node',
    '-e',
    'process.kill(Number(process.argv[1]), "SIGSTOP")',
    daemonPid
  ])
  try {
    const failedProbe = await compose(
      ['exec', '-T', 'orcad', 'node', '/opt/orca/docker/healthcheck.cjs'],
      20000,
      true
    )
    assert.notEqual(failedProbe.code, 0)
    assert.equal(failedProbe.timedOut, false)
    report.negativeHealth = { code: failedProbe.code, diagnosis: failedProbe.stderr.trim() }
  } finally {
    await compose([
      'exec',
      '-T',
      'orcad',
      'node',
      '-e',
      'process.kill(Number(process.argv[1]), "SIGCONT")',
      daemonPid
    ])
  }
  await healthy()
  await compose(['restart', 'orcad'])
  await healthy()
  await verify('restart')
  await compose(['up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180'])
  await healthy()
  await verify('replacement')
  assert.notEqual(report.stages[0].containerId, report.stages[2].containerId)
  await compose(['stop', '-t', '60'])
  const stopped = JSON.parse(
    (await docker(['inspect', '--format', '{{json .State}}', await containerId()])).stdout
  )
  assert.equal(stopped.ExitCode, 0)
  assert.equal(stopped.OOMKilled, false)
  assert.equal(stopped.Running, false)
  report.shutdown = {
    exitCode: stopped.ExitCode,
    oomKilled: stopped.OOMKilled,
    finishedAt: stopped.FinishedAt
  }
  report.outcome = 'passed'
} catch (error) {
  report.outcome = 'failed'
  report.error = error.message
  process.exitCode = 1
  console.error(error.message)
} finally {
  const cleanup = await compose(['down', '--volumes', '--remove-orphans'], 120000, true)
  report.cleanup = { code: cleanup.code, timedOut: cleanup.timedOut }
  if (cleanup.code !== 0) {
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  await mkdir(reportDir, { recursive: true })
  await writeFile(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await rm(scratch, { recursive: true, force: true })
  console.log(`Evidence: ${join(reportDir, 'report.json')}`)
}
